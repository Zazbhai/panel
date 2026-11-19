"""Synthetic, fully intercepted browser checks; never starts server.js or contacts Firebase."""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import importlib.util
import datetime
import json
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('checks', ROOT / 'scripts/verify-frontend.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

class Fixture(checks.Fixture):
    def __init__(self):
        super().__init__()
        now = int(datetime.datetime.now().timestamp() * 1000)
        self.orders = [{
            'orderId': f'{i:024x}', 'service': 'Fixture', 'number': f'90000000{i:02}',
            'deviceId': f'device-{i}', 'databaseUrl': checks.DATABASE,
            'createdAt': now - i * 60000, 'expiresAt': now + 600000,
            'status': 'completed' if i % 2 else 'active', 'receivedOtp': '123456' if i % 2 else None,
            'receivedOtps': [], 'messageHistory': [], 'numberActive': True
        } for i in range(18)]
        self.order_requests = []

    def handle(self, route):
        url = urlparse(route.request.url)
        if url.netloc != 'panel.test' or url.path != '/api/recent-orders':
            return super().handle(route)
        query = parse_qs(url.query)
        self.order_requests.append(query)
        orders = self.orders[:]
        search = query.get('search', [''])[0].lower()
        status = query.get('status', [''])[0]
        if search:
            orders = [o for o in orders if search in ' '.join(str(o[k]) for k in ('orderId', 'service', 'number', 'deviceId')).lower()]
        if status:
            orders = [o for o in orders if o['numberActive']] if status == 'number-active' else [o for o in orders if o['status'] == status]
        if 'from' in query: orders = [o for o in orders if o['createdAt'] >= int(query['from'][0])]
        if 'to' in query: orders = [o for o in orders if o['createdAt'] < int(query['to'][0])]
        orders.sort(key=lambda o: (o['createdAt'], o['orderId']), reverse=True)
        stats = {'total': len(orders), 'waiting': sum(o['status'] == 'active' for o in orders),
                 'completed': sum(o['status'] == 'completed' for o in orders), 'active': len(orders)}
        limit = int(query.get('limit', ['6'])[0])
        start = 0
        if 'before' in query:
            cursor = json.loads(query['before'][0])
            start = next((i + 1 for i, order in enumerate(orders)
                          if order['createdAt'] == cursor['createdAt'] and order['orderId'] == cursor['orderId']), len(orders))
        page = orders[start:start + limit]
        has_more = start + len(page) < len(orders)
        next_cursor = ({'createdAt': page[-1]['createdAt'], 'orderId': page[-1]['orderId']} if has_more and page else None)
        route.fulfill(json={'orders': page, 'stats': stats, 'hasMore': has_more, 'nextCursor': next_cursor})

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(viewport={'width': 1280, 'height': 900}, service_workers='block', reduced_motion='reduce')
        fixture = Fixture()
        context.route('**/*', fixture.handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        checks.ready(page, '/recent-orders')
        expect(page.locator('.order-card')).to_have_count(6)
        expect(page.locator('#totalOrderCount')).to_have_text('18')
        expect(page.locator('#activeNumberCount')).to_have_text('18')
        expect(page.locator('#orderCount')).to_have_text('6 of 18 orders')
        assert fixture.order_requests[-1]['limit'] == ['6']
        page.locator('#showMoreOrders').click()
        expect(page.locator('.order-card')).to_have_count(12)
        assert fixture.order_requests[-1]['limit'] == ['6']
        assert fixture.order_requests[-1]['before']
        assert len(fixture.order_requests[-1]['before']) == 1
        # Find a number outside the loaded page: search must reach server-side history.
        page.locator('#orderSearch').fill('9000000017')
        expect(page.locator('.order-card')).to_have_count(1)
        expect(page.locator('#orderCount')).to_have_text('1 order')
        assert fixture.order_requests[-1]['search'] == ['9000000017']
        page.locator('#orderSearch').fill('')
        page.locator('#orderStatusFilter').select_option('completed')
        expect(page.locator('#totalOrderCount')).to_have_text('9')
        expect(page.locator('.order-card')).to_have_count(6)
        page.locator('[data-range="yesterday"]').click()
        expect(page.locator('.order-card')).to_have_count(0)
        assert 'from' in fixture.order_requests[-1] and 'to' in fixture.order_requests[-1]
        page.locator('[data-range="all"]').click()
        page.locator('#orderStatusFilter').select_option('number-active')
        expect(page.locator('#totalOrderCount')).to_have_text('18')
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        assert not errors, errors
        assert not fixture.blocked, fixture.blocked
        context.close()
        browser.close()
    print('PASS: orders pagination, global search, date/status filters, active totals, and mobile layout; synthetic responses only.')

if __name__ == '__main__':
    main()
