const test = require('node:test')
const assert = require('node:assert')

const { parseSharedView, resolveView, canonicalQuery, DEFAULT_RANGE } = require('../lib/share')
const GraphImage = require('../lib/graphimage')

const servers = ['Vanilla+', 'DonutSMP', 'A & <B>'].map((name, i) => ({
  data: { name, ip: `ip${i}`, color: '#55da95' },
  graphData: []
}))

const FIRST = 1_794_000_000
const LAST = FIRST + 14 * 24 * 60 * 60

test('parses the share params like the frontend', () => {
  assert.deepStrictEqual(parseSharedView('?servers=Vanilla%2B&from=10&to=20'), { servers: ['Vanilla+'], from: 10, to: 20 })
  assert.deepStrictEqual(parseSharedView('?servers=a&servers=b&range=24h'), { servers: ['a', 'b'], range: 86400 })
  assert.deepStrictEqual(parseSharedView('?from=20&to=10'), {})
  assert.deepStrictEqual(parseSharedView(''), {})
  assert.strictEqual(parseSharedView('?' + Array(50).fill('servers=x').join('&')).servers.length, 20)
})

test('resolves servers by exact name and falls back to all', () => {
  const one = resolveView({ servers: ['Vanilla+'] }, servers, FIRST, LAST)
  assert.deepStrictEqual(one.registrations.map(s => s.data.name), ['Vanilla+'])
  assert.strictEqual(one.isAllServers, false)

  const none = resolveView({ servers: ['vanilla+', 'Nope'] }, servers, FIRST, LAST)
  assert.strictEqual(none.registrations.length, 3)
  assert.strictEqual(none.isAllServers, true)
})

test('resolves and clamps the time window', () => {
  assert.deepStrictEqual(pick(resolveView({}, servers, FIRST, LAST)), [LAST - DEFAULT_RANGE, LAST])
  assert.deepStrictEqual(pick(resolveView({ range: 3600 }, servers, FIRST, LAST)), [LAST - 3600, LAST])
  assert.deepStrictEqual(pick(resolveView({ range: 365 * 86400 }, servers, FIRST, LAST)), [FIRST, LAST])
  assert.deepStrictEqual(pick(resolveView({ from: FIRST + 100, to: FIRST + 200 }, servers, FIRST, LAST)), [FIRST + 100, FIRST + 200])
  assert.deepStrictEqual(pick(resolveView({ from: FIRST - 100, to: FIRST + 200 }, servers, FIRST, LAST)), [FIRST, FIRST + 200])
  // A window that scrolled out of the graph shows the default instead
  assert.deepStrictEqual(pick(resolveView({ from: FIRST - 500, to: FIRST - 100 }, servers, FIRST, LAST)), [LAST - DEFAULT_RANGE, LAST])
})

test('canonical query uses absolute rounded bounds', () => {
  const query = canonicalQuery(resolveView({ servers: ['Vanilla+'], range: 3600 }, servers, FIRST, LAST + 37))
  const params = new URLSearchParams(query)
  assert.deepStrictEqual(params.getAll('servers'), ['Vanilla+'])
  assert.strictEqual(params.has('range'), false)
  assert.strictEqual(Number(params.get('to')) % 60, 0)

  // Round trips into the same view
  const again = resolveView(parseSharedView('?' + query), servers, FIRST, LAST + 37)
  assert.strictEqual(canonicalQuery(again), query)

  assert.strictEqual(new URLSearchParams(canonicalQuery(resolveView({}, servers, FIRST, LAST))).has('servers'), false)
})

test('downsampling keeps each bucket peak and gaps', () => {
  const timestamps = Array.from({ length: 3000 }, (_, i) => FIRST + i * 60)
  const registration = { data: { name: 'x', color: '#fff' }, graphData: timestamps.map((_, i) => i === 1234 ? 999 : (i >= 2000 && i < 2100 ? null : 10)) }
  const resolved = { registrations: [registration], from: timestamps[0], to: timestamps[2999] }
  const { times, series } = GraphImage.collectSeries(timestamps, resolved)
  assert.ok(times.length <= 600)
  assert.strictEqual(series[0].peak, 999)
  assert.strictEqual(series[0].latest, 10)
  assert.ok(series[0].values.includes(null))
})

test('axes have round ticks', () => {
  assert.deepStrictEqual(GraphImage.getYAxis(0).ticks, [0, 5, 10])
  const axis = GraphImage.getYAxis(1234)
  assert.ok(axis.max >= 1234)
  assert.ok(axis.ticks.length >= 3 && axis.ticks.length <= 7)
  const ticks = GraphImage.getXTicks(FIRST, FIRST + 3 * 3600)
  assert.ok(ticks.length >= 2 && ticks.length <= 7)
  assert.match(ticks[0].label, /^\d\d:\d\d$/)
})

test('svg escapes server names', () => {
  const timestamps = [FIRST, FIRST + 60]
  const registration = { data: { name: 'A & <B>', color: '#fff' }, graphData: [1, 2] }
  const svg = GraphImage.buildSvg({ registrations: [registration], isAllServers: false, from: FIRST, to: FIRST + 60 }, timestamps)
  assert.ok(svg.includes('A &amp; &lt;B&gt;'))
  assert.ok(!svg.includes('<B>'))
})

function pick (resolved) {
  return [resolved.from, resolved.to]
}

test('server icons are inlined, with the placeholder as fallback', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  assert.strictEqual(GraphImage.getFaviconDataUri({ lastFavicon: png, data: {} }), png)

  const missing = GraphImage.getFaviconDataUri({ data: {} })
  assert.match(missing, /^data:image\/svg\+xml;base64,/)

  // Remote overrides and paths outside favicons/ can't be inlined
  assert.strictEqual(GraphImage.getFaviconDataUri({ lastFavicon: png, data: { favicon: 'https://example.com/a.png' } }), missing)
  assert.strictEqual(GraphImage.getFaviconDataUri({ data: { favicon: '../../package.json' } }), missing)

  const svg = GraphImage.buildSvg({ registrations: [{ data: { name: 'x', color: '#fff' }, lastFavicon: png, graphData: [1, 2] }], isAllServers: false, from: FIRST, to: FIRST + 60 }, [FIRST, FIRST + 60])
  assert.ok(svg.includes(`href="${png}"`))
})

test('time zones are validated and used for labels', () => {
  const { normalizeTimeZone } = require('../lib/share')
  assert.strictEqual(normalizeTimeZone('Europe/London'), 'Europe/London')
  assert.strictEqual(normalizeTimeZone('Not/AZone'), 'UTC')
  assert.strictEqual(normalizeTimeZone('"><script>'), 'UTC')
  assert.strictEqual(normalizeTimeZone(undefined), 'UTC')

  assert.deepStrictEqual(parseSharedView('?tz=Asia%2FTokyo'), { timeZone: 'Asia/Tokyo' })

  // 2026-11-14 16:13:56 UTC is 01:13 the next day in Tokyo
  assert.strictEqual(GraphImage.formatWindow(1794672836, 1794683636, 'UTC'), '14 Nov 2026, 16:13 – 19:13 UTC')
  assert.strictEqual(GraphImage.formatWindow(1794672836, 1794683636, 'Asia/Tokyo'), '15 Nov 2026, 01:13 – 04:13 GMT+9')

  // Day ticks fall on local midnight
  const ticks = GraphImage.getXTicks(1794672836, 1794672836 + 4 * 86400, 'Asia/Tokyo')
  assert.ok(ticks.every(tick => /^\d+ \w{3}$/.test(tick.label)))
  assert.ok(ticks.every(tick => (tick.time + 9 * 3600) % 86400 === 0))

  const query = canonicalQuery(resolveView({ timeZone: 'Asia/Tokyo', history: true }, servers, FIRST, LAST))
  assert.match(query, /history=1/)
  assert.match(query, /tz=Asia%2FTokyo/)
  assert.doesNotMatch(canonicalQuery(resolveView({}, servers, FIRST, LAST)), /tz=|history=/)
})

test('last week lines are drawn dashed when history is on', () => {
  const timestamps = [FIRST, FIRST + 60, FIRST + 120]
  const registration = { serverId: 0, data: { name: 'x', color: '#fff' }, graphData: [1, 2, 3] }
  const lastWeek = { bucketStart: FIRST, bucketSize: 60, graphData: [[50, null, 70]] }
  const resolved = { registrations: [registration], isAllServers: false, from: FIRST, to: FIRST + 120 }

  const withHistory = GraphImage.buildSvg({ ...resolved, history: true }, timestamps, lastWeek)
  assert.ok(withHistory.includes('stroke-dasharray'))
  assert.ok(withHistory.includes('dashed: last week'))
  assert.ok(!GraphImage.buildSvg(resolved, timestamps, lastWeek).includes('stroke-dasharray'))

  const { series } = GraphImage.collectSeries(timestamps, resolved, lastWeek)
  assert.deepStrictEqual(series[0].lastWeekValues, [50, null, 70])
  assert.strictEqual(series[0].lastWeekPeak, 70)
})
