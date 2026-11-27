"""Rotation TXT/CSV imports using intercepted synthetic requests only."""
import importlib.util
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

spec = importlib.util.spec_from_file_location('frontend_fixture', Path(__file__).with_name('verify-frontend.py'))
frontend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frontend)


def main():
    fixture = frontend.Fixture()
    fail_second_batch = False

    def handle(route):
        if (fail_second_batch and route.request.url.endswith('/api/addDatabaseUrls')
                and len(fixture.bulk_requests) == 1):
            route.fulfill(status=503, json={'error': 'Temporary batch failure'})
        else:
            fixture.handle(route)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(service_workers='block')
        context.route('**/*', handle)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        frontend.ready(page, '/rotation')

        def upload(name, text):
            page.locator('#rotationImportFile').set_input_files({
                'name': name, 'mimeType': 'text/csv' if name.endswith('.csv') else 'text/plain',
                'buffer': text.encode()
            })
            page.locator('#rotationImportButton').click()

        upload('links.csv', '\ufeffurl,notes\r\n'
               '"https://csv-one.firebaseio.com/","quoted, note"\r\n'
               '"1. https://csv-one.firebaseio.com",repeat\r\n'
               '"https://csv-two.firebaseio.comhttps://csv-three.firebaseio.com",joined\r\n'
               '"https://unreachable.firebaseio.com","multi\nline"\r\n')
        expect(page.locator('#rotationImportStatus')).to_contain_text('Added 3; 0 already in rotation; 1 invalid or unreachable')
        expect(page.locator('#rotationImportStatus')).to_contain_text('Found 5 links; 1 repeated in file; checked all 4 unique URLs')
        expect(page.locator('#rotationImportErrorRows')).to_contain_text('HTTP 423')
        assert len(fixture.bulk_requests[0]) == 4
        for width in (1440, 768, 390, 320):
            page.set_viewport_size({'width': width, 'height': 900})
            frontend.check_layout(page)
        page.screenshot(path=str(frontend.OUTPUT / 'rotation-csv-mobile.png'), full_page=True)

        # More than two batches must finish; the API's 1,000 URL limit is per request.
        fixture.bulk_requests.clear()
        upload('many.csv', 'url\n' + '\n'.join(f'https://large-{i}.firebaseio.com/' for i in range(2101)))
        expect(page.locator('#rotationImportStatus')).to_contain_text('Added 2101;')
        expect(page.locator('#rotationImportStatus')).to_contain_text('checked all 2101 unique URLs')
        assert [len(batch) for batch in fixture.bulk_requests] == [1000, 1000, 101]

        # Saved additions must remain visible if a later batch request fails.
        fixture.bulk_requests.clear()
        fail_second_batch = True
        upload('partial.txt', '\n'.join(f'https://partial-{i}.firebaseio.com' for i in range(1100)))
        expect(page.locator('#rotationImportStatus')).to_contain_text('Import stopped after 1000 URLs: Temporary batch failure')
        expect(page.locator('#rotationImportStatus')).to_contain_text('Added 1000;')
        expect(page.locator('#rotationImportButton')).to_be_enabled()
        fail_second_batch = False
        fixture.bulk_requests.clear()
        upload('partial.txt', '\n'.join(f'https://partial-{i}.firebaseio.com' for i in range(1100)))
        expect(page.locator('#rotationImportStatus')).to_contain_text('Added 100; 1000 already in rotation;')
        expect(page.locator('#rotationImportStatus')).to_contain_text('checked all 1100 unique URLs')

        upload('broken.csv', 'url\n"unclosed field')
        expect(page.locator('#rotationImportStatus')).to_contain_text('unclosed quoted field')
        if len(sys.argv) > 1:
            # Inspect supplied local CSV structure without contacting any remote endpoint.
            result = page.evaluate('text => { const p = parseRotationImport(text, true); '
                                   'return {links:p.occurrences, repeated:p.repeated, unique:p.urls.length, '
                                   'unsupportedCells:p.failures.length}; }',
                                   Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
            print('Local CSV counts:', result)
        assert not errors, errors
        assert not fixture.blocked, fixture.blocked
        browser.close()
    print('PASS: quoted CSV, joined/numbered links, counts, three batches, partial failure/retry, TXT and responsive layout.')


if __name__ == '__main__':
    main()
