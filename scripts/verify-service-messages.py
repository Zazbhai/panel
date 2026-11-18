"""Latest-six OTP browser checks. Every request is intercepted with synthetic data."""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import importlib.util
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('frontend_checks', ROOT/'scripts/verify-frontend.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

class MessageFixture(checks.Fixture):
    def __init__(self):
        super().__init__()
        self.fail_orders = False
        self.fail_services = False
        self.orders = [
            {'orderId': f'order-{i}', 'service': 'Saved service', 'deviceId': f'device-{i}',
             'createdAt': 1794920000000+i*1000,
             'receivedOtps': [{'code': str(123450+i), 'receivedAt': 1794920000000+i*1000, 'messageKey': f'sms-{i}'}],
             'messageHistory': [{'key': f'sms-{i}', 'timestamp': 1794920000000+i*1000,
                                 'message': {'body': f'Your saved code is {123450+i}.', 'sender': 'TEST'}}]}
            for i in range(9)
        ]

    def handle(self, route):
        url = urlparse(route.request.url)
        if url.netloc == 'panel.test' and url.path.startswith('/api/'):
            assert url.path not in ('/api/config', '/api/data', '/api/device-messages'), 'Unexpected Firebase-related request'
            if url.path == '/api/services':
                route.fulfill(status=503 if self.fail_services else 200,
                              json={'error': 'Synthetic service failure'} if self.fail_services else {'services': []})
                return
            if url.path == '/api/recent-orders':
                assert parse_qs(url.query).get('source') == ['saved']
                route.fulfill(status=503 if self.fail_orders else 200,
                              json={'error': 'Synthetic order failure'} if self.fail_orders else {'orders': self.orders})
                return
        return super().handle(route)

def poll(page):
    page.evaluate('window.fixtureIntervals.find(item => item.delay === 5000).callback()')
    expect(page.locator('#refreshButton')).to_be_enabled()

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(viewport={'width':1440,'height':1000}, service_workers='block', reduced_motion='reduce')
        context.add_init_script('''
          window.fixtureIntervals = [];
          window.setInterval = (callback, delay) => window.fixtureIntervals.push({callback, delay});
          Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {window.copiedMessage = text;}}});
        ''')
        fixture = MessageFixture()
        context.route('**/*', fixture.handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        checks.ready(page, '/service-messages')
        expect(page.locator('#totalMessageCount')).to_have_text('6')
        expect(page.locator('.service-message')).to_have_count(6)
        expect(page.locator('.message-body').first).to_have_text('Your saved code is 123458.')
        expect(page.locator('#showMoreMessages')).not_to_be_visible()
        page.locator('.copy-message').first.click()
        assert page.evaluate('window.copiedMessage') == 'Your saved code is 123458.'
        page.evaluate('window.originalMessageCard = document.querySelector(".service-message")')
        poll(page)
        assert page.evaluate('window.originalMessageCard === document.querySelector(".service-message")')
        expect(page.locator('.copy-message').first).to_be_focused()
        page.locator('#messageSearch').fill('123458')
        expect(page.locator('.service-message')).to_have_count(1)
        page.locator('#messageSearch').fill('not-present')
        expect(page.locator('.message-empty')).to_contain_text('No matching messages')
        page.locator('#messageSearch').fill('')
        fixture.fail_services = True
        poll(page)
        expect(page.locator('.service-message')).to_have_count(6)
        fixture.fail_services = False
        for width in (1440,1024,768,663,390,320):
            page.set_viewport_size({'width':width,'height':1000 if width>700 else 844})
            checks.check_layout(page)
        fixture.fail_orders = True
        page.locator('#refreshButton').click()
        expect(page.locator('#status')).to_contain_text('Synthetic order failure')
        expect(page.locator('.service-message')).to_have_count(6)
        fixture.fail_orders = False
        fixture.orders = []
        poll(page)
        expect(page.locator('.message-empty')).to_contain_text('No OTPs yet')
        expect(page.locator('#totalMessageCount')).to_have_text('0')
        assert not errors, errors
        assert not fixture.blocked, fixture.blocked
        browser.close()
        print('PASS: six newest saved OTPs, deleted/unavailable services, refresh/focus/copy/search, failures and six responsive widths; no Firebase requests.')

if __name__ == '__main__':
    main()
