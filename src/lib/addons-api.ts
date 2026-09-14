import type {APIClient} from '@heroku-cli/command'
import ansis from 'ansis'

const ACCEPT = 'application/vnd.heroku+json; version=3'

export const DATA_ADDON_SERVICE_SLUGS = new Set([
  'heroku-postgresql', 'heroku-postgresql-meta',
  'heroku-redis', 'heroku-redis-meta',
  'heroku-kafka', 'heroku-kafka-meta',
])

const ADVANCED_POSTGRES_PLANS = new Set(['advanced', 'advanced-private', 'advanced-shield'])
const META_ADDON_SERVICE_SLUGS = new Set(['heroku-postgresql-meta', 'heroku-redis-meta', 'heroku-kafka-meta'])
const TEAM_REPORT_CONCURRENCY = 5
const PLATFORM_RETRY_DELAYS_MS = [100, 200, 400]

type PlatformAddon = {
  addon_service: {name: string}
  id: string
  name: string
  plan: {name: string}
}

type Maintenance = {
  addon?: {uuid?: string; window?: string}
  reason?: string
  required_by?: string
  scheduled_for?: string
  status?: string
  window?: string
}

export type AddonReport = {
  addon_name: string
  app_name?: string
  maintenance: {
    reason: string | null
    required_by: string | null
    scheduled_for: string | null
    status: string | null
    window: string | null
  }
  plan: string
  service_slug: string
  service_version: {
    lifecycle_status: 'supported' | 'deprecating' | 'eol' | 'unknown'
    version: string | null
  }
  version_error: string | null
}

export type ReportTarget = {app?: string; team?: string}

type ApiClient = {
  get<T>(path: string, options?: {headers?: Record<string, string>}): Promise<{body: T}>
}

export function formatAddonsTable(addons: AddonReport[], options: {extended?: boolean; includeApp?: boolean} = {}): string {
  const {extended = false, includeApp = false} = options
  const headers = ['Name', 'Plan', ...(includeApp ? ['App'] : []), 'Version', 'Lifecycle', 'Maintenance', ...(extended ? ['Scheduled On'] : [])]
  const rows = addons.map(addon => [
    addon.addon_name,
    extended ? addon.plan : planName(addon.plan),
    ...(includeApp ? [addon.app_name ?? '-'] : []),
    addon.service_version.version ?? '-',
    addon.service_version.lifecycle_status,
    addon.maintenance.status ?? '-',
    ...(extended ? [addon.maintenance.scheduled_for ?? '-'] : []),
  ])
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)))
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()
  const formatDataRow = (row: string[]) => row.map((cell, index) => {
    const padded = index === row.length - 1 ? cell : cell.padEnd(widths[index])
    const lifecycleIndex = includeApp ? 4 : 3
    const maintenanceIndex = lifecycleIndex + 1
    if (index === lifecycleIndex) return formatLifecycleStatus(cell as AddonReport['service_version']['lifecycle_status'], padded)
    if (index === maintenanceIndex) return formatMaintenanceStatus(cell, padded)
    return padded
  }).join('  ')

  return [formatRow(headers), formatRow(widths.map(width => '-'.repeat(width))), ...rows.map(formatDataRow)].join('\n')
}

export function filterAddonsByLifecycle<T extends Pick<AddonReport, 'service_version'>>(addons: T[], lifecycle: 'supported' | 'unsupported' | undefined): T[] {
  if (!lifecycle) return addons

  return addons.filter(addon => lifecycle === 'supported'
    ? addon.service_version.lifecycle_status === 'supported'
    : addon.service_version.lifecycle_status !== 'supported')
}

export function sortAddons(addons: AddonReport[], sort: 'name' | 'app' | 'version'): AddonReport[] {
  return [...addons].sort((left, right) => {
    switch (sort) {
      case 'app':
        return (left.app_name ?? '').localeCompare(right.app_name ?? '') || left.addon_name.localeCompare(right.addon_name)
      case 'version':
        return (left.service_version.version ?? '').localeCompare(right.service_version.version ?? '', undefined, {numeric: true}) ||
          left.addon_name.localeCompare(right.addon_name)
      case 'name':
        return left.addon_name.localeCompare(right.addon_name)
    }
  })
}

export class AddonsApi {
  public constructor(
    private readonly platform: ApiClient,
    private readonly data: ApiClient,
    private readonly metaData: ApiClient,
  ) {}

  public async report(target: ReportTarget): Promise<AddonReport[]> {
    const apps = target.app ? [target.app] : await this.teamApps(target.team!)
    const reports = target.app
      ? await Promise.all(apps.map(async app => this.appReport(app)))
      : await mapConcurrent(apps, TEAM_REPORT_CONCURRENCY, async app => this.appReport(app))
    return reports.flat()
  }

  private async appReport(app: string): Promise<AddonReport[]> {
    const [addons, appInfo] = await Promise.all([
      this.getPlatform<PlatformAddon[]>(`/apps/${encodeURIComponent(app)}/addons`),
      this.getPlatform<{id: string}>(`/apps/${encodeURIComponent(app)}`),
    ])
    const dataAddons = addons.filter(addon => DATA_ADDON_SERVICE_SLUGS.has(baseServiceSlug(addon.addon_service.name)))
    if (dataAddons.length === 0) return []

    const maintenanceByAddonId = await this.maintenances(appInfo.id, dataAddons)

    return Promise.all(dataAddons.map(async addon => {
      const serviceSlug = addon.addon_service.name
      const detail = await this.addonDetail(addon).catch(error => {
        if (!isServerError(error)) throw error
        return {addon_id: addon.id, version_error: errorMessage(error)} as Record<string, string>
      })
      const maintenance = maintenanceByAddonId.get(detail.addon_id ?? addon.id)
      const version = versionString(isPostgres(serviceSlug) ? postgresVersion(detail) : detail.version)

      return {
        addon_name: addon.name,
        app_name: app,
        maintenance: {
          reason: maintenance?.reason ?? null,
          required_by: formatTimestamp(maintenance?.required_by),
          scheduled_for: formatTimestamp(maintenance?.scheduled_for),
          status: maintenance?.status ?? null,
          window: maintenance?.window ?? maintenance?.addon?.window ?? null,
        },
        plan: addon.plan.name,
        service_slug: serviceSlug,
        service_version: {lifecycle_status: lifecycleStatus(serviceSlug, version), version: version ?? null},
        version_error: detail.version_error ?? null,
      }
    }))
  }

  private async teamApps(team: string): Promise<string[]> {
    const apps = await this.getPlatform<Array<{name: string}>>(`/teams/${encodeURIComponent(team)}/apps`)
    return apps.map(app => app.name)
  }

  private async maintenances(appId: string, addons: PlatformAddon[]): Promise<Map<string, Maintenance>> {
    try {
      const responses = await Promise.all([...new Set(addons.map(addon => this.dataClient(addon.addon_service.name)))].map(async client => {
        try {
          return await this.getData<{maintenances?: Maintenance[]}>(client, `/data/maintenances/v1/apps/${appId}`)
        } catch (error) {
          if (isNotFound(error)) return {}
          throw error
        }
      }))
      return new Map(responses.flatMap(response => response.maintenances ?? []).flatMap(maintenance => {
        const id = maintenance.addon?.uuid
        return id ? [[id, maintenance] as const] : []
      }))
    } catch (error) {
      if (isNotFound(error)) return new Map()
      throw error
    }
  }

  private addonPath(serviceSlug: string, addonName: string, addonId: string): string {
    const name = encodeURIComponent(addonName)
    switch (baseServiceSlug(serviceSlug)) {
      case 'heroku-postgresql': return `/client/v11/databases/${name}`
      case 'heroku-redis': return `/redis/v0/databases/${name}`
      case 'heroku-kafka': return `/data/kafka/v0/clusters/${encodeURIComponent(addonId)}`
      default: throw new Error(`Unsupported service slug: ${serviceSlug}`)
    }
  }

  private async addonDetail(addon: PlatformAddon): Promise<Record<string, string>> {
    const client = this.dataClient(addon.addon_service.name)
    if (isAdvancedPostgres(addon)) return this.getData(client, `/data/postgres/v1/${encodeURIComponent(addon.id)}/info`)

    return this.getData(client, this.addonPath(addon.addon_service.name, addon.name, addon.id))
  }

  private dataClient(serviceSlug: string): ApiClient {
    return META_ADDON_SERVICE_SLUGS.has(serviceSlug) ? this.metaData : this.data
  }

  private async getData<T>(client: ApiClient, path: string): Promise<T> {
    return (await client.get<T>(path, {headers: {accept: ACCEPT}})).body
  }

  private async getPlatform<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.platform.get<T>(path, {headers: {accept: ACCEPT}})).body
      } catch (error) {
        const delay = PLATFORM_RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !isTransientPlatformError(error)) throw error
        await sleep(delay)
      }
    }
  }
}

function isAdvancedPostgres(addon: PlatformAddon): boolean {
  return isPostgres(addon.addon_service.name) && ADVANCED_POSTGRES_PLANS.has(planName(addon.plan.name))
}

function isPostgres(serviceSlug: string): boolean {
  return baseServiceSlug(serviceSlug) === 'heroku-postgresql'
}

function baseServiceSlug(serviceSlug: string): string {
  return serviceSlug.replace(/-(?:meta|staging)$/, '').replace(/-meta$/, '')
}

function planName(plan: string): string {
  return plan.slice(plan.indexOf(':') + 1)
}

export function lifecycleStatus(serviceSlug: string, version: string | undefined): AddonReport['service_version']['lifecycle_status'] {
  if (!version) return 'unknown'
  const [major, minor] = version.split('.').map(Number)
  if (Number.isNaN(major)) return 'unknown'
  const service = baseServiceSlug(serviceSlug)
  if (service === 'heroku-kafka' && Number.isNaN(minor)) return 'unknown'
  switch (service) {
    case 'heroku-postgresql':
      if (major <= 14) return 'eol'
      return major === 15 ? 'deprecating' : 'supported'
    case 'heroku-redis':
      if (major <= 6) return 'eol'
      return major === 7 ? 'deprecating' : 'supported'
    case 'heroku-kafka':
      if (major < 2 || major === 2 && minor < 8 || major === 3 && minor < 7) return 'eol'
      return major === 2 || major === 3 && minor === 7 ? 'deprecating' : 'supported'
    default:
      return 'unknown'
  }
}

function formatLifecycleStatus(status: AddonReport['service_version']['lifecycle_status'], text: string = status): string {
  if (!ansis.isSupported()) return text

  switch (status) {
    case 'supported': return ansis.blueBright(text)
    case 'deprecating': return ansis.yellowBright(text)
    case 'eol': return ansis.red(text)
    case 'unknown': return ansis.rgb(255, 165, 0)(text)
  }
}

function formatMaintenanceStatus(status: string, text = status): string {
  if (!ansis.isSupported()) return text

  switch (status) {
    case 'completed': return ansis.green(text)
    case 'ready': return ansis.cyanBright(text)
    case 'running': return ansis.yellowBright(text)
    default: return text
  }
}

function versionString(value: unknown): string | undefined {
  if (Array.isArray(value)) return versionString(value[0])
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function postgresVersion(detail: Record<string, unknown>): unknown {
  return detail.postgres_version ?? detail.version ?? versionFromInfo(detail.info)
}

function versionFromInfo(info: unknown): unknown {
  if (!Array.isArray(info)) return undefined

  const version = info.find(item => typeof item === 'object' && item !== null &&
    'name' in item && item.name === 'PG Version')
  return typeof version === 'object' && version !== null && 'values' in version ? version.values : undefined
}

function formatTimestamp(value: string | undefined): string | null {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404
}

function isServerError(error: unknown): boolean {
  const status = errorStatus(error)
  return status !== null && status >= 500
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode

  if ('http' in error && typeof error.http === 'object' && error.http !== null &&
    'statusCode' in error.http && typeof error.http.statusCode === 'number') return error.http.statusCode

  return null
}

function isTransientPlatformError(error: unknown): boolean {
  return [500, 502, 503, 504].includes(errorStatus(error) ?? 0)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to retrieve version details.'
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index])
    }
  }

  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker))
  return results
}
