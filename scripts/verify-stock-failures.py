"""Stocks failure report checks with intercepted, synthetic requests only."""
import importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

spec = importlib.util.spec_from_file_location('frontend_fixture', Path(__file__).with_name('verify-frontend.py'))
frontend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frontend)


def main():
    fixture = frontend.Fixture()
    failures = [dict(database=f'https://failed-{i:03}.firebaseio.com',
                     reason='HTTP 423: Locked.', checkedAt=1794921000000) for i in range(205)]
    failures[0]['reason'] = '<img src=x onerror=alert(1)> invalid clients list'
    state = dict(status='partial', total=214, completed=214, failed=205, failures=failures)

    def handle(route):
        if route.request.url.endswith('/api/stocks/check'):
            route.fulfill(json=state)
        else:
            fixture.handle(route)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(service_workers='block')
        context.route('**/*', handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        frontend.ready(page, '/stocks')
        rows = page.locator('#databaseFailureRows tr')
        expect(rows).to_have_count(100)
        expect(page.locator('#databaseFailureCount')).to_have_text('205 of 205 failures')
        expect(rows.first).to_contain_text('<img src=x onerror=alert(1)>')
        expect(page.locator('#databaseFailureRows img')).to_have_count(0)
        page.locator('#databaseFailureNext').click()
        expect(rows.first).to_contain_text('failed-100')
        page.locator('#databaseFailureNext').click()
        expect(rows).to_have_count(5)
        expect(page.locator('#databaseFailureNext')).to_be_disabled()
        page.locator('#databaseFailurePrevious').click()
        expect(rows.first).to_contain_text('failed-100')
        search = page.locator('#databaseFailureSearch')
        search.fill('failed-204')
        expect(rows).to_have_count(1)
        expect(rows).to_contain_text('failed-204')
        search.fill('invalid clients')
        expect(rows).to_have_count(1)
        expect(rows).to_contain_text('failed-000')
        search.fill('no match')
        expect(rows).to_contain_text('No matching failures.')
        search.fill('')
        for width in (1440, 768, 390, 320):
            page.set_viewport_size(dict(width=width, height=900))
            frontend.check_layout(page)
        frontend.snapshot(page, 'stock-failures-mobile')
        page.set_viewport_size(dict(width=1440, height=1000))
        frontend.snapshot(page, 'stock-failures-desktop')
        state.update(status='running', total=214, completed=0, failed=0, failures=[])
        page.evaluate('loadManualInventoryCheckStatus()')
        expect(rows).to_contain_text('No failures recorded so far; check in progress.')
        state.update(status='complete', completed=214)
        page.evaluate('loadManualInventoryCheckStatus()')
        expect(rows).to_contain_text('No database failures recorded in this check.')
        assert not errors, errors
        assert not fixture.blocked, fixture.blocked
        browser.close()
    print('PASS: failure URLs/reasons, safe text, 205-row pagination, search, reset and four viewport widths.')


if __name__ == '__main__':
    main()
