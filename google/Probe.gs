// Private, manually started source experiment. No triggers, push, checkout,
// account data, proxy rotation, browser impersonation or automatic retry.
// This is NOT the production collector and is not proof of sustained access.
var PICKUP_URL = 'https://www.apple.com/shop/retail/pickup-message?pl=true&location=01040&parts.0=MK1F4LL%2FA&parts.1=MK1E4LL%2FA';
var EXACT_STORES = ['R191', 'R613', 'R025', 'R446'];
var EXACT_PARTS = ['MK1F4LL/A', 'MK1E4LL/A'];

function authorizeSource() {
  console.log('Authorization complete. No inventory request was made. Return to the conversation before starting the source experiment.');
}

function verifyTenSecondSource() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1)) throw new Error('A source experiment is already running.');
  var report = {startedAt: new Date().toISOString(), targetMs: 10000, samples: [], complete: false};
  var properties = PropertiesService.getScriptProperties();
  try {
    for (var index = 0; index < 24; index++) {
      var due = Date.parse(report.startedAt) + index * 10000;
      if (due > Date.now()) Utilities.sleep(due - Date.now());
      var began = Date.now();
      var sample = {at: new Date(began).toISOString()};
      try {
        var response = UrlFetchApp.fetch(PICKUP_URL, {
          method: 'get', followRedirects: false, muteHttpExceptions: true,
          validateHttpsCertificates: true, timeoutSeconds: 8,
          headers: {Accept: 'application/json', 'Cache-Control': 'no-cache',
            'User-Agent': 'iPhonePickupWatch/2.0 (+https://your-worker.example.com)'}
        });
        sample.durationMs = Date.now() - began;
        sample.status = response.getResponseCode();
        var all = response.getAllHeaders(), headers = {};
        Object.keys(all).forEach(function(key) { headers[key.toLowerCase()] = String(all[key]); });
        sample.date = headers.date || null;
        sample.age = headers.age || null;
        sample.retryAfter = headers['retry-after'] || null;
        var body = response.getContentText();
        if (sample.status === 200) {
          var data = JSON.parse(body), rows = data && data.body && data.body.stores;
          var count = 0;
          EXACT_STORES.forEach(function(store) {
            var row = (Array.isArray(rows) ? rows : []).filter(function(r) { return r && r.storeNumber === store; })[0];
            EXACT_PARTS.forEach(function(part) {
              var option = row && row.partsAvailability && row.partsAvailability[part];
              if (option && option.partNumber === part && typeof option.pickupSearchQuote === 'string' && option.messageTypes && option.messageTypes.regular) count++;
            });
          });
          sample.exactPairs = count;
          var observed = Date.parse(sample.date), age = sample.age === null ? 0 : /^\d+$/.test(sample.age) ? Number(sample.age) * 1000 : NaN;
          sample.current = Number.isFinite(observed) && Number.isFinite(age) && observed <= Date.now() + 60000 && Date.now() - Math.min(observed, Date.now() - age) <= 20000;
        } else {
          sample.title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || null;
        }
      } catch (error) {
        sample.error = String(error.message).slice(0,180);
        sample.durationMs = Date.now() - began;
      }
      report.samples.push(sample);
      properties.setProperty('SOURCE_EXPERIMENT', JSON.stringify(report));
      console.log(JSON.stringify(sample));
      if (sample.status !== 200 || sample.exactPairs !== 8 || !sample.current || sample.durationMs > 8000) break;
    }
    report.complete = true;
    report.finishedAt = new Date().toISOString();
    properties.setProperty('SOURCE_EXPERIMENT', JSON.stringify(report));
    console.log('Experiment finished: ' + report.samples.length + ' samples. No production source or push settings changed.');
  } finally { lock.releaseLock(); }
}
