"""Service-message regression checks. Every browser request uses synthetic data.

Never starts server.js or contacts Firebase. The separate matcher asset deliberately
returns 404 to reproduce older running servers and verify the embedded dependency.
"""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import importlib.util
import json
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('frontend_checks', ROOT/'scripts/verify-frontend.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
DATABASE = checks.DATABASE
LONG_DEVICE = 'fixture-phone-02-' + 'long-device-id-'*8
LONG_TEXT = 'Keep this code private. ' * 18
SECURITY_TEXT = 'Security code {{OTP}}. <img src=x onerror="window.injected=true">'
SERVICES = [
    {'id': 'shop', 'name': 'Flipkart', 'enabled': True, 'template': 'Your Flipkart code is {{OTP}}.'},
    {'id': 'bank', 'name': 'Test Bank', 'enabled': True, 'senderFilter': 'BANK', 'minOtpLength': 4, 'maxOtpLength': 6, 'templates': [
        {'text': 'Bank code {{OTP}} expires in 10 minutes.', 'enabled': True},
        {'text': 'Your banking code is {{OTP}}. '+LONG_TEXT, 'enabled': True},
        {'text': 'Use {{OTP}} to sign in.', 'enabled': False},
    ]},
    {'id': 'security', 'name': 'Security', 'enabled': True, 'template': SECURITY_TEXT},
    {'id': 'disabled', 'name': 'Disabled service', 'enabled': False, 'template': 'Disabled {{OTP}}.'},
    {'id': 'disabled-template', 'name': 'Disabled templates', 'enabled': True, 'templates': [{'text': 'Hidden {{OTP}}.', 'enabled': False}]},
]

class MessageFixture(checks.Fixture):
    def __init__(self):
        super().__init__()
        self.services = SERVICES.copy()
        self.reads = []
        self.helper_requests = 0
        self.fail_services = False
        self.fail_config = False
        self.fail_devices = set()
        self.no_devices = False
        self.extra = False

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        query = parse_qs(url.query)
        if url.netloc == 'panel.test' and request.method == 'GET':
            if url.path == '/service-matching.js':
                self.helper_requests += 1
                route.fulfill(status=404, body='Not found', content_type='text/plain')
                return
            if url.path.startswith('/api/'):
                self.reads.append((url.path, query.get('deviceId', [''])[0]))
            if url.path == '/api/services':
                if self.fail_services:
                    route.fulfill(status=503, json={'error': 'Synthetic service failure'})
                else:
                    route.fulfill(json={'services': self.services})
                return
            if url.path == '/api/config' and self.fail_config:
                route.fulfill(status=503, json={'error': 'Synthetic config failure'})
                return
            if url.path == '/api/data':
                assert query == {'section': ['clients'], 'database': [DATABASE]}
                route.fulfill(json={} if self.no_devices else {'fixture-phone-01': {'status': True}, LONG_DEVICE: {'status': True}, 'offline-phone': {'status': False}})
                return
            if url.path == '/api/device-messages':
                device = query['deviceId'][0]
                assert device in ('fixture-phone-01', LONG_DEVICE, 'offline-phone'), 'Unexpected device message request'
                if device in self.fail_devices:
                    route.fulfill(status=503, json={'error': 'Synthetic message failure'})
                    return
                if device == 'offline-phone':
                    data = {}
                elif device == 'fixture-phone-01':
                    data = {str(1794920000000-i*60000): {'message': f'Your Flipkart code is {123450+i}.', 'sender': 'VM-FLIPK', 'timestamp': 1794920000000-i*60000} for i in range(21)}
                    data['1794921000000'] = {'body': SECURITY_TEXT.replace('{{OTP}}','654321'), 'sender': 'TEST-SECURITY', 'timestamp': 1794921000000}
                    data['excluded'] = {'message': 'JOIN TELEGRAM Your Flipkart code is 123456.'}
                    if self.extra:
                        data['1794922000000'] = {'message': 'Your Flipkart code is 999999.', 'timestamp': 1794922000000}
                else:
                    data = {str(1794919000000-i*60000): {'text': f'Bank code {3450+i} expires in 10 minutes.', 'sender': 'VM-BANK', 'timestamp': 1794919000000-i*60000} for i in range(6)}
                    data['1794917000000'] = {'message': 'Your banking code is 456789. '+LONG_TEXT, 'sender': 'BANK'}
                    data['disabled-template'] = {'message': 'Use 123456 to sign in.', 'sender': 'BANK'}
                    data['wrong-sender'] = {'message': 'Bank code 123456 expires in 10 minutes.', 'sender': 'NOT-A-MATCH'}
                    data['too-short'] = {'message': 'Bank code 123 expires in 10 minutes.', 'sender': 'BANK'}
                    data['too-long'] = {'message': 'Bank code 1234567 expires in 10 minutes.', 'sender': 'BANK'}
                route.fulfill(json=data)
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
          Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {
            if (window.failClipboard) throw new Error('Synthetic clipboard denial');
            window.copiedMessage = text;
          }}});
        ''')
        fixture = MessageFixture()
        context.route('**/*', fixture.handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        checks.ready(page,'/service-messages')
        expect(page.locator('#refreshButton')).to_be_enabled()
        expect(page.locator('#status')).to_have_text('')
        expect(page.locator('#totalMessageCount')).to_have_text('29')
        expect(page.locator('#activeDeviceCount')).to_have_text('2')
        expect(page.locator('#enabledServiceCount')).to_have_text('3')
        expect(page.locator('#serviceFilter option')).to_have_count(4)
        expect(page.locator('.service-message')).to_have_count(12)
        expect(page.locator('#messageCount')).to_have_text('12 of 29 messages')
        assert fixture.helper_requests == 0, 'Still depends on a matcher asset unavailable on older servers'
        assert page.locator('script[data-service-matching]').count() == 1
        assert sum(path == '/api/config' for path,_ in fixture.reads) == 1, 'Duplicate config request on connect'
        assert ('/api/device-messages', 'offline-phone') in fixture.reads, 'Offline device messages were skipped'
        assert page.evaluate('typeof window.serviceMatching.getEnabledTemplates') == 'function'
        assert not page.locator('.message-body img, .message-body script').count()
        assert page.evaluate('window.injected !== true')
        expect(page.locator('.service-message .service-name').first).to_have_text('Security')
        assert not page.locator('.is-arriving').count(), 'Motion enabled despite reduced-motion preference'
        print('PASS: matching works with the standalone helper unavailable; legacy and multiple enabled templates; sender/OTP rules; offline devices are still queried; escaped message text; newest-first sorting.')

        # Existing cards and keyboard focus survive polling; new messages animate once.
        first = page.locator('.service-message').first
        first.locator('.copy-message').click()
        expect(first.locator('.copy-feedback')).to_have_text('Copied')
        assert page.evaluate('window.copiedMessage') == SECURITY_TEXT.replace('{{OTP}}','654321')
        page.evaluate('window.originalMessageCard = document.querySelector(".service-message")')
        poll(page)
        assert page.evaluate('window.originalMessageCard === document.querySelector(".service-message")')
        expect(first.locator('.copy-message')).to_be_focused()
        page.evaluate('window.failClipboard=true')
        first.locator('.copy-message').click()
        expect(first.locator('.copy-feedback')).to_have_text('Select the text to copy.')
        page.evaluate('window.failClipboard=false')
        page.emulate_media(reduced_motion='no-preference')
        fixture.extra = True
        poll(page)
        expect(page.locator('.message-body').first).to_have_text('Your Flipkart code is 999999.')
        assert page.evaluate('window.originalMessageCard === document.querySelectorAll(".service-message")[1]')
        assert page.locator('.is-arriving').count() <= 1, 'Unchanged cards replayed arrival animations'
        page.emulate_media(reduced_motion='reduce')
        fixture.extra = False

        reads = list(fixture.reads)
        page.locator('#showMoreMessages').click()
        expect(page.locator('.service-message')).to_have_count(24)
        expect(page.locator('.service-message').nth(12)).to_be_focused()
        page.locator('#showMoreMessages').click()
        expect(page.locator('.service-message')).to_have_count(30)
        expect(page.locator('#showMoreMessages')).not_to_be_visible()
        assert fixture.reads == reads, 'Show more fetched another collection'
        page.locator('#serviceFilter').select_option('Test Bank')
        expect(page.locator('.service-message')).to_have_count(7)
        expect(page.locator('#messageCount')).to_have_text('7 messages')
        page.locator('#messageSearch').fill('3450')
        expect(page.locator('.service-message')).to_have_count(1)
        page.locator('#messageSearch').fill('Your Flipkart')
        expect(page.locator('.message-empty')).to_contain_text('No matching messages')
        page.locator('#serviceFilter').select_option('')
        expect(page.locator('.service-message')).to_have_count(12)
        page.locator('#messageSearch').fill(LONG_DEVICE)
        expect(page.locator('.service-message')).to_have_count(7)
        assert fixture.reads == reads, 'Search or filtering fetched more data'
        page.locator('#messageSearch').fill('')
        expect(page.locator('.service-message')).to_have_count(12)
        switch = page.get_by_role('switch',name='Auto-refresh')
        switch.focus()
        page.keyboard.press('Space')
        expect(switch).not_to_be_checked()
        poll(page)
        assert fixture.reads == reads, 'Paused auto-refresh still requested data'
        page.locator('#refreshButton').click()
        expect(page.locator('#totalMessageCount')).to_have_text('29')
        assert len(fixture.reads) > len(reads), 'Manual refresh stopped working while auto-refresh paused'
        print('PASS: stable cards/focus on background refresh; new-card-only animations; copy feedback; twelve-message batches; full-list search/service filters without requests; keyboard switch and manual refresh while paused.')

        for width in (1440,1024,768,663,390,320):
            page.set_viewport_size({'width':width,'height':1000 if width>700 else 844})
            checks.check_layout(page)
            checks.snapshot(page,f'service-messages-redesign-{width}')
        page.locator('#serviceFilter').select_option('Test Bank')
        page.locator('#messageSearch').fill('Your banking code')
        expect(page.locator('.service-message')).to_have_count(1)
        checks.check_layout(page)
        checks.snapshot(page,'service-messages-long-320')
        page.set_viewport_size({'width':1440,'height':1000})
        page.locator('#messageSearch').fill('')
        page.locator('#serviceFilter').select_option('')

        fixture.fail_devices = {LONG_DEVICE}
        page.locator('#refreshButton').click()
        expect(page.locator('#status')).to_contain_text('Messages unavailable for 1 device')
        expect(page.locator('#totalMessageCount')).to_have_text('22')
        expect(page.locator('.service-message')).to_have_count(12)
        fixture.fail_devices.update({'fixture-phone-01', 'offline-phone'})
        page.locator('#refreshButton').click()
        expect(page.locator('.message-empty')).to_contain_text('Could not load messages')
        expect(page.locator('#refreshButton')).to_be_enabled()
        fixture.fail_devices.clear()
        fixture.no_devices = True
        page.locator('#refreshButton').click()
        expect(page.locator('.message-empty')).to_contain_text('No devices found')
        expect(page.locator('#activeDeviceCount')).to_have_text('0')
        fixture.no_devices = False
        fixture.services = []
        page.locator('#refreshButton').click()
        expect(page.locator('.message-empty')).to_contain_text('No enabled templates')
        expect(page.locator('#serviceFilter')).to_be_disabled()
        expect(page.locator('#messageCount')).to_have_text('0 messages')
        reads_before = list(fixture.reads)
        page.locator('#refreshButton').click()
        expect(page.locator('#refreshButton')).to_be_enabled()
        assert fixture.reads[len(reads_before):] == [('/api/services','')], 'No-service state fetched database records'

        fixture.services = SERVICES.copy()
        fixture.fail_services = True
        checks.ready(page,'/service-messages')
        expect(page.locator('.message-empty')).to_contain_text('Could not load messages')
        expect(page.locator('#status')).to_contain_text('Synthetic service failure')
        fixture.fail_services = False
        fixture.fail_config = True
        page.locator('#refreshButton').click()
        expect(page.locator('#status')).to_contain_text('Synthetic config failure')
        fixture.fail_config = False
        page.locator('#refreshButton').click()
        expect(page.locator('#totalMessageCount')).to_have_text('29')
        expect(page.locator('#status')).to_have_text('')
        expect(page.locator('#messageList')).to_have_attribute('aria-busy','false')
        print('PASS: responsive cards at six widths; long text/IDs; partial and total message failures; empty/no-service states; initial-load failure and retry.')

        assert not errors, errors
        assert not fixture.writes, fixture.writes
        assert not fixture.blocked, fixture.blocked
        report = {'missing_matcher_asset':'passed','template_matching':'passed','search_and_filters':'passed','copy_message':'passed','background_refresh':'passed','motion_preferences':'passed','responsive_widths':[1440,1024,768,663,390,320],'failure_recovery':'passed','api_writes':0,'external_requests':0,'javascript_errors':errors}
        (checks.OUTPUT/'service-messages-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        context.close()
        browser.close()

if __name__ == '__main__':
    main()
