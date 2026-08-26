import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import ansis from 'ansis'
import {afterEach, describe, it} from 'mocha'
import nock from 'nock'
import {AddonsApi, filterAddonsByLifecycle, formatAddonsTable, lifecycleStatus, sortAddons} from '../src/lib/addons-api.js'
import type {AddonReport} from '../src/lib/addons-api.js'

function apiClient(host: string) {
  return {
    async get<T>(path: string, _options?: {headers?: Record<string, string>}): Promise<{body: T}> {
      const response = await fetch(`https://${host}${path}`)
      if (!response.ok) throw {statusCode: response.status}
      return {body: await response.json() as T}
    },
  }
}

describe('AddonsApi', () => {
  afterEach(() => nock.cleanAll())

  it('reports an app data add-on with version lifecycle and maintenance', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-postgresql'}, id: 'platform-id', name: 'postgresql-encircled-1', plan: {name: 'heroku-postgresql:premium-0'}},
        {addon_service: {name: 'papertrail'}, id: 'ignored', name: 'papertrail-1', plan: {name: 'choklad'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: [
        {addon: {uuid: 'data-id', window: 'Sundays'}, reason: 'routine_maintenance', scheduled_for: '2026-09-01T00:00:00Z', status: 'ready'},
      ]})
      .get('/client/v11/databases/postgresql-encircled-1').reply(200, {addon_id: 'data-id', postgres_version: '15.17'})

    const report = await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'})

    assert.deepEqual(report, [{
      addon_name: 'postgresql-encircled-1',
      app_name: 'example',
      maintenance: {reason: 'routine_maintenance', required_by: null, scheduled_for: '2026-09-01 00:00:00 UTC', status: 'ready', window: 'Sundays'},
      plan: 'heroku-postgresql:premium-0',
      service_slug: 'heroku-postgresql',
      service_version: {lifecycle_status: 'deprecating', version: '15.17'},
      version_error: null,
    }])
  })

  it('reports every app in a team', async () => {
    nock('https://api.heroku.com')
      .get('/teams/data/apps').reply(200, [{name: 'first'}, {name: 'second'}])
      .get('/apps/first/addons').reply(200, [])
      .get('/apps/first').reply(200, {id: 'first-id'})
      .get('/apps/second/addons').reply(200, [])
      .get('/apps/second').reply(200, {id: 'second-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/first-id').reply(404)
      .get('/data/maintenances/v1/apps/second-id').reply(404)

    assert.deepEqual(await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({team: 'data'}), [])
  })

  it('limits concurrent app reports for teams', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    const platform = {
      async get<T>(path: string): Promise<{body: T}> {
        if (path === '/teams/data/apps') return {body: Array.from({length: 10}, (_, index) => ({name: `app-${index}`})) as T}

        activeRequests++
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
        await delay(5)
        activeRequests--
        return {body: (path.endsWith('/addons') ? [] : {id: path.split('/')[2]}) as T}
      },
    }

    await new AddonsApi(platform, apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({team: 'data'})
    assert.equal(maxActiveRequests, 10)
  })

  it('ignores a missing maintenance endpoint returned by the core API client', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-postgresql'}, id: 'platform-id', name: 'postgresql-encircled-1', plan: {name: 'premium-0'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/app-id').reply(404)
      .get('/client/v11/databases/postgresql-encircled-1').reply(200, {addon_id: 'platform-id', postgres_version: '16.0'})

    assert.equal((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0].maintenance.status, null)
  })

  it('does not query the Data API for an app without supported add-ons', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'papertrail'}, id: 'ignored', name: 'papertrail-1', plan: {name: 'choklad'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})

    assert.deepEqual(await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}), [])
  })

  it('reports an add-on when its version endpoint returns a server error', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-postgresql-meta'}, id: 'postgres-id', name: 'postgres-meta-1', plan: {name: 'heroku-postgresql-meta:private-0'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://shogun-meta.herokai.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: []})
      .get('/client/v11/databases/postgres-meta-1').reply(500, {id: 'internal_server_error', message: 'Internal server error.'})

    const report = await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'})
    assert.equal(report[0].service_version.version, null)
    assert.equal(report[0].version_error, 'Unable to retrieve version details.')
  })

  it('normalizes numeric service versions before determining lifecycle status', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-redis'}, id: 'redis-id', name: 'redis-1', plan: {name: 'heroku-redis:premium-0'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: []})
      .get('/redis/v0/databases/redis-1').reply(200, {addon_id: 'redis-id', version: 8})

    assert.deepEqual((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0].service_version, {
      lifecycle_status: 'supported', version: '8',
    })
  })

  it('gets Kafka versions by add-on UUID', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-kafka'}, id: 'kafka-id', name: 'kafka-1', plan: {name: 'heroku-kafka:basic-0'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: []})
      .get('/data/kafka/v0/clusters/kafka-id').reply(200, {addon_id: 'kafka-id', version: ['3.7.1']})

    assert.deepEqual((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0].service_version, {
      lifecycle_status: 'deprecating', version: '3.7.1',
    })
  })

  it('gets Essential Postgres versions from the legacy database endpoint', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-postgresql'}, id: 'postgres-id', name: 'postgres-essential-1', plan: {name: 'heroku-postgresql:essential-0'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: []})
      .get('/client/v11/databases/postgres-essential-1').reply(200, {
        addon_id: 'postgres-id',
        info: [{name: 'PG Version', values: ['16.2']}],
      })

    assert.deepEqual((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0].service_version, {
      lifecycle_status: 'supported', version: '16.2',
    })
  })

  it('gets Advanced Postgres version metadata by add-on UUID', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-postgresql'}, id: 'postgres-id', name: 'postgresql-advanced-1', plan: {name: 'heroku-postgresql:advanced-private'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://api.data.heroku.com')
      .get('/data/maintenances/v1/apps/app-id').reply(404)
      .get('/data/postgres/v1/postgres-id/info').reply(200, {version: '17.4'})

    assert.deepEqual((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0].service_version, {
      lifecycle_status: 'supported', version: '17.4',
    })
  })

  it('reports meta add-ons from the Meta control plane', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-redis-meta'}, id: 'redis-id', name: 'heroku-redis-meta-1', plan: {name: 'heroku-redis-meta:premium-0'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://shogun-meta.herokai.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: []})
      .get('/redis/v0/databases/heroku-redis-meta-1').reply(200, {addon_id: 'redis-id', version: '7.2'})

    assert.deepEqual((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0].service_version, {
      lifecycle_status: 'deprecating', version: '7.2',
    })
  })

  it('gets Advanced Meta Postgres metadata from the Meta control plane', async () => {
    nock('https://api.heroku.com')
      .get('/apps/example/addons').reply(200, [
        {addon_service: {name: 'heroku-postgresql-meta'}, id: 'postgres-id', name: 'postgres-meta-1', plan: {name: 'heroku-postgresql-meta:advanced-shield'}},
      ])
      .get('/apps/example').reply(200, {id: 'app-id'})
    nock('https://shogun-meta.herokai.com')
      .get('/data/maintenances/v1/apps/app-id').reply(200, {maintenances: []})
      .get('/data/postgres/v1/postgres-id/info').reply(200, {version: '17.4'})

    assert.deepEqual((await new AddonsApi(apiClient('api.heroku.com'), apiClient('api.data.heroku.com'), apiClient('shogun-meta.herokai.com')).report({app: 'example'}))[0], {
      addon_name: 'postgres-meta-1',
      app_name: 'example',
      maintenance: {reason: null, required_by: null, scheduled_for: null, status: null, window: null},
      plan: 'heroku-postgresql-meta:advanced-shield',
      service_slug: 'heroku-postgresql-meta',
      service_version: {lifecycle_status: 'supported', version: '17.4'},
      version_error: null,
    })
  })

  it('formats a compact table for terminal output', () => {
    assert.equal(ansis.strip(formatAddonsTable([{
      addon_name: 'postgresql-encircled-1',
      maintenance: {reason: null, required_by: null, scheduled_for: '2026-09-01 00:00:00 UTC', status: 'ready', window: null},
      plan: 'heroku-postgresql:premium-0',
      service_slug: 'heroku-postgresql',
      service_version: {lifecycle_status: 'deprecating', version: '15.17'},
      version_error: null,
    }])), [
      'Name                    Plan       Version  Lifecycle    Maintenance',
      '----------------------  ---------  -------  -----------  -----------',
      'postgresql-encircled-1  premium-0  15.17    deprecating  ready',
    ].join('\n'))
  })

  it('includes the app column when requested', () => {
    assert.match(ansis.strip(formatAddonsTable([{
      addon_name: 'postgresql-encircled-1',
      app_name: 'example-app',
      maintenance: {reason: null, required_by: null, scheduled_for: null, status: 'ready', window: null},
      plan: 'heroku-postgresql:premium-0',
      service_slug: 'heroku-postgresql',
      service_version: {lifecycle_status: 'deprecating', version: '15.17'},
      version_error: null,
    }], {includeApp: true})), /Plan\s+App\s+Version/)
  })

  it('shows full plan and schedule details when extended', () => {
    assert.match(ansis.strip(formatAddonsTable([{
      addon_name: 'postgresql-encircled-1',
      maintenance: {reason: null, required_by: null, scheduled_for: '2026-09-01 00:00:00 UTC', status: 'ready', window: null},
      plan: 'heroku-postgresql:premium-0',
      service_slug: 'heroku-postgresql',
      service_version: {lifecycle_status: 'deprecating', version: '15.17'},
      version_error: null,
    }], {extended: true})), /Scheduled On[\s\S]*heroku-postgresql:premium-0/)
  })

  it('filters reports by lifecycle status', () => {
    const supported = {service_version: {lifecycle_status: 'supported' as const}}
    const unsupported = {service_version: {lifecycle_status: 'eol' as const}}
    const reports = [supported, unsupported]

    assert.deepEqual(filterAddonsByLifecycle(reports, 'supported'), [supported])
    assert.deepEqual(filterAddonsByLifecycle(reports, 'unsupported'), [unsupported])
    assert.deepEqual(filterAddonsByLifecycle(reports, undefined), reports)
  })

  it('classifies versions according to documented lifecycle policies', () => {
    assert.equal(lifecycleStatus('heroku-postgresql', '14.9'), 'eol')
    assert.equal(lifecycleStatus('heroku-postgresql', '15.4'), 'deprecating')
    assert.equal(lifecycleStatus('heroku-postgresql', '16.1'), 'supported')
    assert.equal(lifecycleStatus('heroku-redis', '7.2.14'), 'deprecating')
    assert.equal(lifecycleStatus('heroku-redis', '8.1.7'), 'supported')
    assert.equal(lifecycleStatus('heroku-kafka', '2.8.2'), 'deprecating')
    assert.equal(lifecycleStatus('heroku-kafka', '3.7.1'), 'deprecating')
    assert.equal(lifecycleStatus('heroku-kafka', '3.9.2'), 'supported')
  })

  it('sorts reports by name, app, and semantic version', () => {
    const reports = [
      {addon_name: 'zeta', app_name: 'beta', service_version: {lifecycle_status: 'supported' as const, version: '3.10'}},
      {addon_name: 'alpha', app_name: 'alpha', service_version: {lifecycle_status: 'supported' as const, version: '3.9'}},
    ] as AddonReport[]

    assert.deepEqual(sortAddons(reports, 'name').map(addon => addon.addon_name), ['alpha', 'zeta'])
    assert.deepEqual(sortAddons(reports, 'app').map(addon => addon.app_name), ['alpha', 'beta'])
    assert.deepEqual(sortAddons(reports, 'version').map(addon => addon.service_version.version), ['3.9', '3.10'])
  })
})
