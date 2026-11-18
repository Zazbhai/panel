"""Focused checks for the redesigned orders and services pages, synthetic data only."""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import importlib.util
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('checks', ROOT/'scripts/verify-frontend.py')
checks = importlib.util.module_from_spec(spec); spec.loader.exec_module(checks)
DATABASE = checks.DATABASE

class Fixture(checks.Fixture):
    def __init__(self):
        super().__init__()
        self.services.extend({
            'id': f'fixture-service-{i}',
            'name': f'Fixture service {i}',
            'template': 'Fixture code {{OTP}} ' + str(i),
            'enabled': True
        } for i in range(8))
        self.orders = [
            {'orderId': f'order-{i}', 'service': 'Flipkart' if i % 2 else 'Test service', 'number': f'90000000{i:02}', 'deviceId': f'device-{i}', 'databaseUrl': DATABASE, 'createdAt': 1794873600000 + i*86400000, 'expiresAt': 1794960000000 + i*86400000, 'receivedAt': 1794960000000 + i*86400000, 'locked': i%2==0, 'receivedOtp': '123456' if i%3==0 else None, 'status': ['completed','active','expired'][i%3], 'numberActive': i%3==0}
            for i in range(12)
        ]
        self.orders[0]['service'] = 'Flipkart'
        self.orders[0]['messageHistory'] = [{
            'key': 'message-0',
            'timestamp': self.orders[0]['createdAt'] + 1000,
            'message': {'message': 'Your verification code is 123456. Do not share it.'}
        }]
        self.writes = []
        self.reads = []

    def handle(self, route):
        request = route.request; url = urlparse(request.url); query = parse_qs(url.query)
        if url.netloc == 'panel.test' and request.method == 'GET':
            if url.path == '/api/recent-orders': route.fulfill(json={'orders': self.orders}); return
            if url.path == '/api/services': route.fulfill(json={'initialized': True, 'services': self.services}); return
            if url.path == '/api/device-messages':
                self.reads.append((query.get('database',[''])[0], query.get('deviceId',[''])[0]))
                route.fulfill(json=checks.MESSAGES); return
        return super().handle(route)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(viewport={'width':1440,'height':1000}, service_workers='block', reduced_motion='reduce')
        fixture = Fixture(); context.route('**/*', fixture.handle); page = context.new_page(); errors=[]; page.on('pageerror',lambda e: errors.append(str(e)))
        page.add_init_script("""
            window.__dashboardIntervals = [];
            const nativeSetInterval = window.setInterval;
            window.setInterval = (callback, delay) => {
                const handle = nativeSetInterval(callback, delay);
                window.__dashboardIntervals.push({ callback, delay, handle });
                return handle;
            };
        """)
        checks.ready(page, '/recent-orders')
        expect(page.locator('.order-card')).to_have_count(6)
        expect(page.locator('#totalOrderCount')).to_have_text('12')
        expect(page.locator('#activeNumberCount')).to_have_text('4')
        expect(page.locator('.order-card[data-order-id="order-6"]')).to_have_attribute('data-number-active', 'true')
        expect(page.locator('#orderCount')).to_have_text('6 of 12 orders')
        fixture.orders = fixture.orders[:-1] + [{**fixture.orders[-1], 'orderId': 'order-refreshed'}]
        page.evaluate("window.__dashboardIntervals.find((entry) => entry.delay === 5000).callback()")
        expect(page.locator('.order-reference').first).to_have_text('order-refreshed')
        page.locator('#showMoreOrders').click(); expect(page.locator('.order-card')).to_have_count(12); expect(page.locator('#showMoreOrders')).not_to_be_visible()
        page.locator('[data-range="today"]').click(); expect(page.locator('#orderCount')).to_have_text('1 order')
        page.locator('[data-range="yesterday"]').click(); expect(page.locator('#orderCount')).to_have_text('1 order')
        page.locator('[data-range="week"]').click(); expect(page.locator('#orderCount')).to_have_text('6 orders')
        page.locator('[data-range="month"]').click(); expect(page.locator('#orderCount')).to_have_text('6 of 12 orders')
        page.locator('[data-range="custom"]').click(); expect(page.locator('#customOrderDates')).to_be_visible()
        page.locator('#orderDateFrom').fill('2026-11-18'); page.locator('#orderDateTo').fill('2026-11-18'); page.locator('#customOrderDates button').click(); expect(page.locator('#orderCount')).to_have_text('1 order')
        page.locator('[data-range="all"]').click(); page.locator('#orderStatusFilter').select_option('active'); expect(page.locator('.order-card')).to_have_count(4)
        page.locator('#orderStatusFilter').select_option('number-active'); expect(page.locator('.order-card')).to_have_count(4)
        page.locator('#orderStatusFilter').select_option(''); page.locator('#orderSearch').fill('order-0'); expect(page.locator('.order-card')).to_have_count(1); page.locator('#orderSearch').fill('')
        page.locator('[data-range="all"]').click(); page.locator('#showMoreOrders').click(); reads_before = len(fixture.reads); order_zero = page.locator('.order-card[data-order-id="order-0"]'); trigger = order_zero.locator('.order-details-trigger'); trigger.click(); expect(order_zero.locator('.order-dialog[open]')).to_be_visible(); expect(order_zero.locator('.order-detail-panel')).to_be_visible(); expect(order_zero.locator('.order-message-status')).to_be_visible(); expect(order_zero.locator('.order-dialog .message-body')).to_contain_text('123456'); assert len(fixture.reads) == reads_before
        order_zero.locator('.order-all-messages-trigger').click(); expect(page.locator('#deviceMessagesDialog[open]')).to_be_visible(); expect(page.locator('#deviceMessagesContext')).to_contain_text('device-0'); expect(page.locator('#deviceMessagesList .message-body')).to_contain_text('123456'); assert fixture.reads[-1] == (DATABASE, 'device-0')
        page.keyboard.press('Escape'); expect(page.locator('#deviceMessagesDialog[open]')).to_have_count(0); page.keyboard.press('Escape'); expect(order_zero.locator('.order-dialog[open]')).to_have_count(0); expect(trigger).to_be_focused()
        for width in (1440,1024,768,390,320): page.set_viewport_size({'width':width,'height':1000 if width>600 else 844}); checks.check_layout(page)
        checks.ready(page, '/services'); expect(page.locator('.service-card')).to_have_count(6); expect(page.locator('#showMoreServices')).to_be_visible(); page.locator('#showMoreServices').click(); expect(page.locator('.service-card')).to_have_count(10); page.locator('#serviceSearch').fill('Fixture service 7'); expect(page.locator('.service-card')).to_have_count(1); page.locator('#serviceSearch').fill(''); expect(page.locator('.template-editor')).to_have_count(1); page.locator('#addServiceButton').click(); expect(page.locator('#serviceEditorDialog[open]')).to_be_visible(); page.locator('#addTemplateButton').click(); page.locator('#addTemplateButton').click(); expect(page.locator('.template-editor')).to_have_count(3); expect(page.locator('#templateCount')).to_have_text('3')
        for width in (1440,1024,768,390,320): page.set_viewport_size({'width':width,'height':1000 if width>600 else 844}); checks.check_layout(page)
        assert not errors, errors; assert not fixture.blocked, fixture.blocked; print('PASS: order cards, date presets, custom range, search/status filters, saved messages, click-to-load all device messages and responsive layouts; compact multi-template service editor and responsive layouts.')
        context.close(); browser.close()
if __name__ == '__main__': main()
