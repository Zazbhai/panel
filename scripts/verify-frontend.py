"""Frontend smoke checks using synthetic responses only.

Requires Python Playwright and a locally installed Chromium browser. Every request
is intercepted; this never starts server.js or contacts a database/provider.
Run: python scripts/verify-frontend.py
"""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import copy
import json
import re
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / '.preview'
OUTPUT.mkdir(exist_ok=True)
ROUTES = {'/': 'active-devices', '/active-devices': 'active-devices', '/services': 'services', '/rotation': 'rotation', '/service-messages': 'service-messages', '/recent-orders': 'recent-orders', '/api-docs': 'api-docs'}
DATABASE = 'https://preview-only.firebaseio.com'
SERVICES = [
    {'id': 'fixture-1', 'name': 'Flipkart', 'template': 'Your verification code is {{OTP}}. Do not share it.', 'enabled': True},
    {'id': 'fixture-2', 'name': 'Test service', 'template': 'Use {{OTP}} to sign in.', 'enabled': False},
]
DEVICES = {'test-device-01': {'model': 'Test device', 'phoneNumber': '9000000001', 'status': True}}
CLIENTS = {'test-device-01': {'status': True, 'battery': 86, 'ping': {'ts': 1794921000000, 'wake': True}}, 'test-device-02': {'status': True, 'battery': 52, 'ping': {'ts': 1794921010000, 'wake': False}}}
MESSAGES = {'1794921000000': {'message': 'Your verification code is 123456. Do not share it.', 'sender': 'TEST-SENDER', 'timestamp': 1794921000000}}

class Fixture:
    def __init__(self):
        self.services = copy.deepcopy(SERVICES)
        self.rotation = [DATABASE]
        self.writes = []
        self.blocked = []
        self.failure = None
        self.empty = False

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        path = url.path
        if url.netloc != 'panel.test':
            self.blocked.append(request.url)
            route.abort()
            return
        if path in ROUTES:
            route.fulfill(body=(ROOT / (ROUTES[path]+'.html')).read_bytes(), content_type='text/html; charset=utf-8')
            return
        if path.endswith('.js') and '/' not in path[1:] and (ROOT / path[1:]).is_file():
            route.fulfill(body=(ROOT / path[1:]).read_bytes(), content_type='text/javascript; charset=utf-8')
            return
        if path == '/favicon.ico':
            route.fulfill(status=204)
            return
        if path.startswith('/api/') or path == '/stubs/handler_api.php':
            if path == self.failure:
                route.fulfill(status=503, json={'error': 'Preview request failed. Try again.'})
                return
            if path == '/api/rotation/device-stats':
                route.fulfill(json={'status': 'idle'})
                return
            if request.method in ('POST', 'PUT'):
                body = request.post_data_json
                self.writes.append({'path': path, 'body': body})
                if path == '/api/services': self.services = body['services']
                if path == '/api/rotation': self.rotation = body['databaseUrls']
            section = parse_qs(url.query).get('section', [''])[0]
            if path == '/api/config': data = {'databaseUrl': DATABASE}
            elif path == '/api/health': data = {'status': 'ok'}
            elif path == '/api/services': data = {'initialized': True, 'services': [] if self.empty else self.services}
            elif path == '/api/rotation': data = {'initialized': True, 'databaseUrls': self.rotation}
            elif path == '/api/sections': data = {'devices': True, 'clients': True}
            elif path == '/api/data': data = {} if self.empty else CLIENTS if section == 'clients' else DEVICES
            elif path == '/api/device-record': data = DEVICES['test-device-01']
            elif path == '/api/device-messages': data = {} if self.empty else MESSAGES
            elif path == '/api/send-sms': data = {'id': 'fixture-sms', 'status': 'pending'}
            elif path == '/api/recent-orders':
                data = {'orders': [] if self.empty else [dict(orderId=f'fixture-order-{i:02}', service='Flipkart' if i % 2 else 'Test service', number='9000000001', deviceId='test-device-01', databaseUrl=DATABASE, createdAt=1794921000000-i*60000, locked=i%3==0, receivedOtp='123456' if i%3==0 else None, status=['completed','active','expired'][i%3]) for i in range(1,9)]}
            elif path == '/api/otp-provider': data = {'fixture': 'Provider response'}
            elif path == '/stubs/handler_api.php':
                route.fulfill(body='ACCESS_NUMBER:fixture-order:9000000001', content_type='text/plain')
                return
            else:
                raise AssertionError(f'Unmocked API: {path}')
            route.fulfill(json=data)
            return
        raise AssertionError(f'Unmocked URL: {request.url}')

def ready(page, path):
    page.goto('http://panel.test'+path)
    page.wait_for_load_state('networkidle')
    expect(page.locator('h1')).to_be_visible()

def snapshot(page, name):
    page.screenshot(path=str(OUTPUT / (name+'.png')), full_page='dialog' not in name)

def check_layout(page):
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Page overflows horizontally'
    assert page.locator('[data-dashboard-styles]').count() == 1
    assert page.locator('style').count() == 1, 'Unexpected competing stylesheet'
    assert page.locator('.page-nav a[aria-current="page"]').count() == 1
    assert not page.locator('body').inner_text().find('`r`n') >= 0, 'Literal escape rendered'
    assert page.locator('button').evaluate_all('(buttons) => buttons.every(b => !!(b.textContent.trim() || b.getAttribute("aria-label")))'), 'Button missing a name'

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome', args=['--disable-background-networking'])
        context = browser.new_context(viewport={'width':1440,'height':1000}, service_workers='block', reduced_motion='reduce')
        fixture = Fixture()
        context.route('**/*', fixture.handle)
        errors = []
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        for width in (1440, 1024, 768, 390, 320):
            page.set_viewport_size({'width':width,'height':1000 if width > 600 else 844})
            for route, name in ROUTES.items():
                ready(page, route)
                check_layout(page)
                if width in (1440,390): snapshot(page, name+f'-{width}')
                if width <= 768:
                    expect(page.locator('.mobile-bottom-nav')).to_be_visible()
                    expect(page.locator('.mobile-bottom-nav a')).to_have_count(6)
                    expect(page.locator('.mobile-bottom-nav a[aria-current="page"]')).to_have_count(1)
                    expect(page.locator('.nav-toggle')).not_to_be_visible()
                    expect(page.locator('.page-nav')).not_to_be_visible()
        print('PASS: all seven pages at 1440, 1024, 768, 390 and 320px; mobile navigation.')

        page.set_viewport_size({'width':1440,'height':1000})
        ready(page, '/')
        page.locator('#refreshSmsDevicesButton').click()
        expect(page.locator('#sendSmsButton')).to_be_enabled()
        page.locator('#sendSmsButton').click()
        expect(page.locator('#smsDeviceId')).to_have_attribute('aria-invalid','true')
        expect(page.locator('#smsDeviceId')).to_be_focused()
        page.locator('#smsDeviceId').select_option('test-device-01')
        expect(page.locator('#smsDeviceId')).not_to_have_attribute('aria-invalid','true')
        page.locator('#smsDestination').fill('+910000000000')
        message = '<script>not executable</script>\nYour test message.'
        page.locator('#smsBody').fill(message)
        page.locator('#sendSmsButton').click()
        dialog = page.get_by_role('dialog')
        expect(dialog).to_be_visible()
        expect(dialog.locator('.dialog-message')).to_have_text(message)
        expect(dialog.get_by_role('button',name='Cancel',exact=True)).to_be_focused()
        for _ in range(6):
            page.keyboard.press('Tab')
            assert page.evaluate('document.querySelector("dialog").contains(document.activeElement)'), 'Focus escaped modal'
        snapshot(page,'sms-dialog-desktop')
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        expect(page.locator('#sendSmsButton')).to_be_focused()
        assert not [w for w in fixture.writes if w['path']=='/api/send-sms']
        page.locator('#sendSmsButton').click()
        page.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
        assert not [w for w in fixture.writes if w['path']=='/api/send-sms']
        page.set_viewport_size({'width':390,'height':620})
        page.locator('#smsBody').fill('A long message. '*100)
        page.locator('#sendSmsButton').click()
        snapshot(page,'sms-dialog-mobile')
        page.get_by_role('dialog').get_by_role('button',name='Queue SMS',exact=True).click()
        expect(page.locator('#smsStatus')).to_contain_text('Queued')
        sms = [w for w in fixture.writes if w['path']=='/api/send-sms']
        assert len(sms)==1
        assert sms[0]['body']=={'database':DATABASE,'deviceId':'test-device-01','destination':'+910000000000','message':'A long message. '*100,'sim':1}
        print('PASS: inline form errors; escaped message preview; modal focus trap, Escape, Cancel and focus return; unchanged SMS payload; one request on confirmation.')

        page.set_viewport_size({'width':1440,'height':1000})
        ready(page, '/')
        page.locator('#discoverButton').click()
        expect(page.locator('#sectionPanel')).to_be_visible()
        page.locator('.section-checkbox').first.check()
        assert page.locator('#selectAll').evaluate('(e)=>e.indeterminate')
        page.locator('#selectAll').check()
        page.locator('#loadButton').click()
        expect(page.locator('#results .record')).to_have_count(3)
        page.locator('#recordSearch').fill('test-device-01')
        page.locator('#recordKey').fill('test-device-01')
        page.locator('#recordLookupButton').click()
        expect(page.locator('#deviceLookupResult .record')).to_be_visible()
        snapshot(page,'overview-records')

        ready(page, '/services')
        switch = page.get_by_role('switch',name='Enable Flipkart')
        expect(switch).to_be_checked()
        switch.focus()
        page.keyboard.press('Space')
        expect(page.get_by_role('switch',name='Enable Flipkart')).not_to_be_checked()
        assert fixture.services[0]['enabled'] is False
        card = page.locator('.service-card').filter(has_text='Flipkart')
        card.get_by_role('button',name='Remove',exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('Remove Flipkart?')
        snapshot(page,'remove-service-dialog')
        writes = len(fixture.writes)
        page.keyboard.press('Escape')
        assert len(fixture.writes)==writes
        card.get_by_role('button',name='Edit',exact=True).click()
        expect(page.locator('#serviceName')).to_have_value('Flipkart')
        page.locator('#cancelEditButton').click()
        expect(page.locator('#serviceEditorDialog[open]')).to_have_count(0)
        page.locator('#addServiceButton').click()
        expect(page.locator('#serviceEditorDialog[open]')).to_be_visible()
        page.locator('#serviceName').fill('New test service')
        page.locator('#messageTemplate').fill('Use 123456 to verify.')
        page.locator('#messageTemplate').evaluate('(e)=>e.setSelectionRange(4,10)')
        page.locator('[data-template-action="mark"]').first.click()
        expect(page.locator('#messageTemplate')).to_have_value('Use {{OTP}} to verify.')
        page.locator('#saveServiceButton').click()
        expect(page.locator('#serviceStatus')).to_contain_text('saved')
        expect(page.locator('.service-card')).to_have_count(3)
        page.locator('#enableAllServicesButton').click()
        expect(page.get_by_role('dialog')).to_contain_text('Enable all services?')
        page.get_by_role('dialog').get_by_role('button',name='Enable all',exact=True).click()
        expect(page.locator('#serviceActionStatus')).to_have_text('Enabled 3 services.')
        assert all(service['enabled'] for service in fixture.services)
        expect(page.locator('#enableAllServicesButton')).to_be_disabled()
        card = page.locator('.service-card').filter(has_text='New test service')
        card.get_by_role('button',name='Remove',exact=True).click()
        page.get_by_role('dialog').get_by_role('button',name='Remove service',exact=True).click()
        expect(page.locator('.service-card')).to_have_count(2)
        print('PASS: record section selection/search/lookup; service switch keyboard operation, template marking, save/edit/cancel, enable-all confirmation and remove confirmation.')

        ready(page, '/active-devices')
        expect(page.locator('#dbUrl')).to_have_js_property('tagName', 'SELECT')
        expect(page.locator('.device-card')).to_have_count(2)
        expect(page.locator('#totalDeviceCount')).to_have_text('2')
        assert page.locator('input[type="datetime-local"], #timeFrom, #timeTo, #latestOtpDetails').count() == 0
        page.locator('.message-summary').first.click()
        expect(page.locator('.message-section').first.locator('.message-body')).to_be_visible()
        page.locator('#deviceSearch').fill('test-device-01')
        expect(page.locator('#deviceCount')).to_have_text('1 device')
        page.locator('#deviceSearch').fill('')
        snapshot(page,'devices-expanded')

        ready(page, '/rotation')
        page.locator('#databaseUrls').fill(DATABASE+'\nhttps://second-preview.firebaseio.com')
        page.locator('#saveRotationButton').click()
        expect(page.locator('#rotationStatus')).to_contain_text('Saved 2')
        assert fixture.rotation==[DATABASE,'https://second-preview.firebaseio.com']

        ready(page, '/api-docs')
        page.locator('#applyDashboardApiKey').click()
        expect(page.locator('#dashboardApiKeyStatus')).to_have_class('error')
        page.locator('#dashboardApiKey').fill('synthetic-preview-key')
        page.locator('#applyDashboardApiKey').click()
        expect(page.locator('#dashboardApiKeyStatus')).to_contain_text('accepted')
        page.locator('[data-action="getNumber"] button').click()
        expect(page.locator('[data-action="getNumber"] .response')).to_contain_text('ACCESS_NUMBER')
        page.locator('[data-action="getCountries"] button').click()
        expect(page.locator('[data-action="getCountries"] .request-status')).to_contain_text('provider API key')
        print('PASS: device database selector/cards/search/disclosures; date controls removed; rotation form; API key panel and request forms.')

        fixture.failure = '/api/services'
        ready(page, '/services')
        expect(page.locator('#serviceStatus')).to_have_class(re.compile('error'))
        snapshot(page,'service-error-state')
        fixture.failure = '/api/config'
        ready(page, '/')
        expect(page.locator('#status')).to_have_class('status error')
        expect(page.locator('#discoverButton')).to_be_disabled()
        snapshot(page,'connection-error-state')
        fixture.failure = None
        fixture.empty = True
        for route in ('/services','/recent-orders','/active-devices','/service-messages'):
            ready(page, route)
            snapshot(page, ROUTES[route]+'-empty')
            assert page.locator('.empty, .device-empty, .service-list > .hint').count()
        print('PASS: connection/request error and empty states. All API responses were synthetic; no production server started.')
        assert not errors, '\n'.join(errors)
        assert not fixture.blocked, f'Unexpected external requests: {fixture.blocked}'
        report = {'pages':len(ROUTES),'widths':[1440,1024,768,390,320],'javascript_errors':errors,'external_requests':fixture.blocked,'synthetic_writes':len(fixture.writes)}
        (OUTPUT/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        context.close()
        browser.close()

if __name__=='__main__':
    main()
