"""Exercise device database selection and cards without contacting any backend.

Uses the same fully intercepted browser as verify-frontend.py. All identities,
URLs, phone numbers and messages below are synthetic fixtures.
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
FIRST = checks.DATABASE
SECOND = 'https://second-preview.firebaseio.com'
FIRST_CLIENTS = {
    'phone-01': {'status': True, 'battery': 86, 'ping': {'ts': 1794921000000}},
    'phone-02': {'status': False, 'battery': 12, 'ping': {'ts': 1794801000000}},
    'phone-03': {'status': True, 'battery': '57%', 'ping': {'ts': 1794922000000}},
    'phone-04': {'status': True, 'battery': 48, 'ping': {'ts': 1794921000000}},
    'phone-05': {'status': False, 'battery': 68, 'ping': {'ts': 1794501000000}},
}
FIRST_DEVICES = {
    'phone-01': {'model': 'Infinix X6525B', 'sim1Number': '+91 90000 00001', 'sim2': {'number': '+91 90000 00002'}},
    'phone-02': {'model': 'Samsung SM-A066B', 'phoneNumber': '9000000003'},
    'phone-03': {'model': 'OPPO CPH2895', 'sims': [{'number': '9000000004'}, {'number': '9000000005'}]},
    'phone-04': {'model': 'Redmi 22111317I', 'phone': '9000000006'},
    'phone-05': {'deviceName': 'Nokia C22', 'phoneNumber': '9000000007'},
    'registered-only': {'model': 'Vivo V2238', 'phoneNumber': '9000000008'},
}

class DeviceFixture(checks.Fixture):
    def __init__(self):
        super().__init__()
        self.rotation = [FIRST, SECOND]
        self.reads = []
        self.fail_rotation = False
        self.fail_config = False
        self.fail_clients = False
        self.fail_devices = False
        self.fail_messages = False
        self.changed_status = False
        self.large = False
        self.large_count = 500
        self.large_status_changed = False

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        query = parse_qs(url.query)
        if url.netloc == 'panel.test' and request.method == 'GET':
            if (url.path == '/api/rotation' and self.fail_rotation) or (url.path == '/api/config' and self.fail_config):
                route.fulfill(status=503, json={'error': 'Synthetic settings error'})
                return
            if url.path == '/api/data':
                section = query['section'][0]
                database = query['database'][0]
                assert database in (FIRST, SECOND)
                self.reads.append((database, section))
                if (section == 'clients' and self.fail_clients) or (section == 'devices' and self.fail_devices):
                    route.fulfill(status=503, json={'error': 'Synthetic section error'})
                    return
                if self.empty:
                    data = None
                elif self.large:
                    data = {f'large-device-{i:04}': {'model': f'Test phone {i}', 'status': i % 2 == 0 and not (i == 0 and self.large_status_changed), 'battery': i % 101, 'phoneNumber': str(9000000000+i)} for i in range(self.large_count)}
                elif database == FIRST:
                    data = dict(FIRST_CLIENTS if section == 'clients' else FIRST_DEVICES)
                    if section == 'clients' and self.changed_status:
                        data['phone-01'] = {'status': False, 'battery': 83, 'ping': {'ts': 1794923000000}}
                elif section == 'clients':
                    data = {'phone-01': {'status': True, 'battery': 72, 'ping': {'ts': 1794921000000}}}
                else:
                    data = {'phone-01': {'model': 'Second database phone', 'phoneNumber': '9000000099'}}
                route.fulfill(json=data)
                return
            if url.path == '/api/device-messages':
                database = query['database'][0]
                self.reads.append((database, 'messages'))
                if self.fail_messages:
                    route.fulfill(status=503, json={'error': 'Synthetic message error'})
                else:
                    text = 'Database A: your OTP is 123456.' if database == FIRST else 'Database B: your OTP is 654321.'
                    route.fulfill(json={'1794921000000': {'message': text, 'timestamp': 1794921000000, 'sender': 'TEST-SENDER'}, '1794821000000': {'message': 'An older message with no date filter.', 'timestamp': 1794821000000}, '1794911000000': {'message': 'JOIN TELEGRAM test message', 'timestamp': 1794911000000}})
                return
        return super().handle(route)

def card(page, text):
    return page.locator('.device-card').filter(has=page.locator('.device-title',has_text=text))

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(viewport={'width':1440,'height':1000}, service_workers='block', reduced_motion='reduce')
        fixture = DeviceFixture()
        context.route('**/*',fixture.handle)
        page = context.new_page()
        errors = []
        page.on('pageerror',lambda error:errors.append(str(error)))
        checks.ready(page,'/active-devices')
        expect(page.locator('#dbUrl option')).to_have_count(2)
        expect(page.locator('.device-card')).to_have_count(6)
        expect(page.locator('#totalDeviceCount')).to_have_text('6')
        expect(page.locator('#onlineDeviceCount')).to_have_text('3')
        expect(page.locator('#offlineDeviceCount')).to_have_text('3')
        expect(page.locator('#showMoreDevices')).not_to_be_visible()
        expect(card(page,'Vivo V2238').locator('.device-state')).to_have_text('Offline')
        expect(card(page,'Samsung').locator('.device-state')).to_have_text('Offline')
        expect(card(page,'Infinix').locator('.device-phone')).to_have_count(2)
        expect(card(page,'Infinix').locator('.device-phone dt')).to_have_text(['SIM 1','SIM 2'])
        expect(card(page,'OPPO').locator('.device-phone')).to_have_count(2)
        expect(card(page,'Samsung').locator('.device-battery')).to_contain_text('12%')
        assert not [r for r in fixture.reads if r[1]=='messages'], 'Messages fetched before expansion'
        assert not page.locator('input[type="datetime-local"],#timeFrom,#timeTo,#latestOtpDetails').count()

        for width in (1440,1024,768,663,390,320):
            page.set_viewport_size({'width':width,'height':1000 if width>600 else 844})
            checks.check_layout(page)
            assert page.locator('.device-search-control').evaluate('(control)=>{const input=control.querySelector("input");const icon=control.querySelector("svg");return input.getBoundingClientRect().left+parseFloat(getComputedStyle(input).paddingLeft)>icon.getBoundingClientRect().right+4}'), 'Search icon overlaps input text'
            checks.snapshot(page,f'device-cards-{width}')
        page.set_viewport_size({'width':1440,'height':1000})
        page.locator('[data-status="online"]').click()
        expect(page.locator('.device-card')).to_have_count(3)
        expect(page.locator('.device-state')).to_have_text(['Online']*3)
        expect(page.locator('[data-status="online"]')).to_have_attribute('aria-pressed','true')
        page.locator('[data-status="offline"]').click()
        expect(page.locator('.device-card')).to_have_count(3)
        expect(page.locator('.device-state')).to_have_text(['Offline']*3)
        page.locator('[data-status="all"]').click()
        page.locator('#deviceSearch').fill('9000000005')
        expect(page.locator('.device-card:visible')).to_have_count(1)
        expect(card(page,'OPPO')).to_be_visible()
        page.locator('#deviceSearch').fill('no-such-device')
        expect(page.locator('.search-empty')).to_be_visible()
        expect(page.locator('#deviceCount')).to_have_text('0 devices')
        expect(page.locator('#showMoreDevices')).not_to_be_visible()
        page.locator('[data-status="offline"]').click()
        page.locator('#dbUrl').select_option(SECOND)
        expect(page.locator('#deviceSearch')).to_have_value('')
        expect(page.locator('.device-card')).to_have_count(1)
        expect(card(page,'Second database phone')).to_be_visible()
        expect(page.locator('#totalDeviceCount')).to_have_text('1')
        expect(page.locator('#onlineDeviceCount')).to_have_text('1')
        expect(page.locator('#offlineDeviceCount')).to_have_text('0')
        expect(page.locator('[data-status="all"]')).to_have_attribute('aria-pressed','true')
        print('PASS: saved database dropdown; registered and offline devices; truthful counts; SIM/phone metadata; responsive cards; search; automatic reload on database selection.')

        page.locator('#dbUrl').select_option(FIRST)
        expect(page.locator('.device-card')).to_have_count(6)
        card(page,'Infinix').locator('.message-summary').click()
        expect(card(page,'Infinix').locator('.message-body')).to_have_count(2)
        expect(card(page,'Infinix').locator('.message-body').first).to_have_text('Database A: your OTP is 123456.')
        expect(card(page,'Infinix').locator('.message-body').last).to_have_text('An older message with no date filter.')
        assert 'JOIN TELEGRAM' not in page.locator('#deviceList').inner_text()
        fixture.changed_status = True
        # Exercise status polling without waiting for its 30-second timer.
        reads_before = list(fixture.reads)
        page.evaluate('loadDevices(true)')
        added_reads = fixture.reads[len(reads_before):]
        assert [section for _,section in added_reads if section != 'messages'] == ['clients'], added_reads
        expect(card(page,'Infinix').locator('.device-state')).to_have_text('Offline')
        expect(card(page,'Infinix').locator('.message-section')).to_have_attribute('open','')
        expect(page.locator('#onlineDeviceCount')).to_have_text('2')
        expect(page.locator('#offlineDeviceCount')).to_have_text('4')

        # Delay intercepted responses in the browser, without adding any real network request.
        page.evaluate('''() => {
          window.pendingDeviceDelays = 0;
          const fetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await fetch(...args);
            const url = new URL(args[0],location.href);
            if (window.delayDeviceDatabase && url.searchParams.get('database') === window.delayDeviceDatabase && (!window.delayMessagesOnly || url.pathname === '/api/device-messages')) {
              window.pendingDeviceDelays++;
              await new Promise(resolve=>setTimeout(resolve,500));
              window.pendingDeviceDelays--;
            }
            return response;
          };
        }''')
        page.locator('#dbUrl').select_option(SECOND)
        expect(card(page,'Second database phone')).to_be_visible()
        page.evaluate('(database)=>window.delayDeviceDatabase=database',FIRST)
        page.locator('#dbUrl').select_option(FIRST)
        page.wait_for_function('window.pendingDeviceDelays>0')
        page.locator('#dbUrl').select_option(SECOND)
        expect(card(page,'Second database phone')).to_be_visible()
        page.wait_for_function('window.pendingDeviceDelays===0')
        expect(page.locator('.device-card')).to_have_count(1)
        expect(card(page,'Second database phone')).to_be_visible()

        page.evaluate('window.delayDeviceDatabase=null')
        page.locator('#dbUrl').select_option(FIRST)
        expect(page.locator('.device-card')).to_have_count(6)
        page.evaluate('(database)=>{window.delayDeviceDatabase=database;window.delayMessagesOnly=true}',FIRST)
        card(page,'Infinix').locator('.message-summary').click()
        page.wait_for_function('window.pendingDeviceDelays>0')
        page.locator('#dbUrl').select_option(SECOND)
        expect(card(page,'Second database phone')).to_be_visible()
        card(page,'Second database phone').locator('.message-summary').click()
        expect(card(page,'Second database phone').locator('.message-body').first).to_have_text('Database B: your OTP is 654321.')
        page.wait_for_function('window.pendingDeviceDelays===0')
        assert 'Database A:' not in page.locator('#deviceList').inner_text()
        page.evaluate('window.delayDeviceDatabase=null')
        print('PASS: message disclosure retains older messages; existing message exclusion preserved; live status updates; expanded cards retained; stale device/message responses cannot overwrite a new database.')

        fixture.fail_messages = True
        card(page,'Second database phone').locator('.message-summary').click()
        card(page,'Second database phone').locator('.message-summary').click()
        expect(page.locator('.message-error')).to_be_visible()
        fixture.fail_messages = False
        card(page,'Second database phone').locator('.message-summary').click()
        card(page,'Second database phone').locator('.message-summary').click()
        expect(page.locator('.message-body')).to_have_count(2)

        fixture.fail_clients = True
        page.locator('#refreshButton').click()
        expect(page.locator('.device-state')).to_have_text('Unknown')
        expect(page.locator('#onlineDeviceCount')).to_have_text('—')
        expect(page.locator('#offlineDeviceCount')).to_have_text('—')
        expect(page.locator('#status')).to_contain_text('unknown status')
        page.locator('[data-status="offline"]').click()
        expect(page.locator('.device-card')).to_have_count(0)
        expect(page.locator('.search-empty')).to_be_visible()
        expect(page.locator('#showMoreDevices')).not_to_be_visible()
        page.locator('[data-status="all"]').click()
        checks.snapshot(page,'device-status-unavailable')
        fixture.fail_clients = False
        fixture.fail_devices = True
        page.locator('#refreshButton').click()
        expect(page.locator('.device-card')).to_have_count(1)
        expect(page.locator('#status')).to_contain_text('Registered device details are unavailable')
        fixture.fail_devices = False
        fixture.fail_rotation = True
        page.locator('#refreshButton').click()
        expect(page.locator('#dbUrl option')).to_have_count(1)
        expect(page.locator('#databaseNotice')).to_be_visible()
        fixture.fail_config = True
        checks.ready(page,'/active-devices')
        expect(page.locator('#dbUrl')).to_be_disabled()
        expect(page.locator('#refreshButton')).to_be_enabled()
        expect(page.locator('#status')).to_contain_text('Try Refresh')
        fixture.fail_rotation = False
        fixture.fail_config = False
        fixture.empty = True
        page.locator('#refreshButton').click()
        expect(page.locator('.device-empty')).to_contain_text('No devices in this database')
        expect(page.locator('#totalDeviceCount')).to_have_text('0')
        expect(page.locator('#showMoreDevices')).not_to_be_visible()
        print('PASS: message retry; unknown rather than false offline status; partial results; default-database fallback; settings retry; empty database.')

        fixture.empty = False
        fixture.large = True
        page.locator('#refreshButton').click()
        expect(page.locator('.device-card')).to_have_count(6)
        expect(page.locator('#totalDeviceCount')).to_have_text('500')
        expect(page.locator('#deviceCount')).to_have_text('6 of 500 devices')
        expect(page.locator('#showMoreDevices')).to_be_visible()
        reads_before = list(fixture.reads)
        first_card = card(page,'Test phone 0').first
        first_card.locator('.message-summary').click()
        expect(first_card.locator('.message-body')).to_have_count(2)
        page.evaluate('window.firstDeviceCard = document.querySelector(".device-card")')
        reads_after_messages = list(fixture.reads)
        page.locator('#showMoreDevices').click()
        expect(page.locator('.device-card')).to_have_count(12)
        expect(page.locator('#deviceCount')).to_have_text('12 of 500 devices')
        expect(card(page,'Test phone 6').locator('.device-title')).to_be_focused()
        assert page.evaluate('window.firstDeviceCard === document.querySelector(".device-card")')
        expect(first_card.locator('.message-section')).to_have_attribute('open','')
        assert fixture.reads == reads_after_messages, 'Show more unexpectedly fetched a collection or messages'
        page.locator('#showMoreDevices').click()
        expect(page.locator('.device-card')).to_have_count(18)

        # Status filters and search apply to the entire collection before batching.
        page.locator('[data-status="online"]').click()
        expect(page.locator('.device-card')).to_have_count(6)
        expect(page.locator('#deviceCount')).to_have_text('6 of 250 devices')
        expect(page.locator('.device-state')).to_have_text(['Online']*6)
        page.locator('#showMoreDevices').click()
        expect(page.locator('.device-card')).to_have_count(12)
        expect(page.locator('.device-state')).to_have_text(['Online']*12)
        fixture.large_status_changed = True
        background_reads = len(fixture.reads)
        page.evaluate('loadDevices(true)')
        expect(page.locator('.device-card')).to_have_count(12)
        expect(page.locator('#deviceCount')).to_have_text('12 of 249 devices')
        expect(card(page,'Test phone 0')).to_have_count(0)
        assert fixture.reads[background_reads:] == [(FIRST,'clients')]
        page.locator('[data-status="offline"]').click()
        expect(page.locator('.device-card')).to_have_count(6)
        expect(page.locator('#deviceCount')).to_have_text('6 of 251 devices')
        expect(page.locator('.device-state')).to_have_text(['Offline']*6)
        page.locator('#deviceSearch').fill('large-device-0499')
        expect(page.locator('.device-card:visible')).to_have_count(1)
        expect(page.locator('#showMoreDevices')).not_to_be_visible()
        page.locator('[data-status="online"]').click()
        expect(page.locator('.search-empty')).to_be_visible()
        page.locator('[data-status="all"]').click()
        expect(page.locator('.device-card')).to_have_count(1)
        page.locator('#deviceSearch').fill('')
        expect(page.locator('.device-card')).to_have_count(6)
        assert [read for read in fixture.reads[len(reads_before):] if read[1] != 'messages'] == [(FIRST,'clients')], 'Paging, searching or filtering fetched another collection'
        checks.snapshot(page,'device-batches-1440')
        for width in (768,390,320):
            page.set_viewport_size({'width':width,'height':844})
            checks.check_layout(page)
            checks.snapshot(page,f'device-batches-{width}')
        page.set_viewport_size({'width':1440,'height':1000})

        # A short final batch hides Show more and moves focus to the new cards.
        fixture.large_count = 14
        page.locator('#refreshButton').click()
        expect(page.locator('#totalDeviceCount')).to_have_text('14')
        expect(page.locator('.device-card')).to_have_count(6)
        page.locator('#showMoreDevices').click()
        expect(page.locator('.device-card')).to_have_count(12)
        expect(page.locator('#showMoreDevices')).to_have_attribute('aria-label','Show 2 more devices')
        page.locator('#showMoreDevices').click()
        expect(page.locator('.device-card')).to_have_count(14)
        expect(page.locator('#deviceCount')).to_have_text('14 devices')
        expect(page.locator('#showMoreDevices')).not_to_be_visible()
        expect(card(page,'Test phone 12').locator('.device-title')).to_be_focused()
        page.locator('#dbUrl').select_option(SECOND)
        expect(page.locator('.device-card')).to_have_count(6)
        expect(page.locator('[data-status="all"]')).to_have_attribute('aria-pressed','true')
        checks.check_layout(page)
        assert not fixture.writes
        assert not fixture.blocked
        assert not errors, errors
        (checks.OUTPUT/'device-verification.json').write_text(json.dumps({'database_selection':'passed','offline_and_registered_devices':'passed','stale_response_isolation':'passed','message_history':'passed','failure_recovery':'passed','large_list':500,'six_card_batches':'passed','status_filters':'passed','cached_details_during_polling':'passed','api_writes':0,'external_requests':0,'javascript_errors':errors},indent=2),encoding='utf-8')
        print('PASS: 500-device list in six-card batches; complete-list search/status filters; final partial batch; focus and disclosures retained; no collection requests on Show more/filter/search; cached details during polling; no API writes, external requests or JavaScript errors.')
        context.close()
        browser.close()

if __name__ == '__main__':
    main()
