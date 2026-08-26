import {Args, Flags} from '@oclif/core'
import {APIClient, Command} from '@heroku-cli/command'
import {AddonsApi, filterAddonsByLifecycle, formatAddonsTable, sortAddons} from '../../lib/addons-api.js'

export default class DataReport extends Command {
  public static description = 'report Heroku Postgres, Redis, and Kafka add-ons'

  public static args = {
    app: Args.string({description: 'app to report on', required: false}),
  }

  public static flags = {
    app: Flags.string({char: 'a', description: 'app to report on'}),
    extended: Flags.boolean({description: 'show full plan names and scheduled timestamps'}),
    json: Flags.boolean({description: 'output the report as JSON'}),
    sort: Flags.string({description: 'sort by name, app, or version', options: ['name', 'app', 'version']}),
    supported: Flags.boolean({description: 'show only add-ons with supported versions'}),
    team: Flags.string({description: 'team whose apps should be reported'}),
    unsupported: Flags.boolean({description: 'show only add-ons without supported versions'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(DataReport)
    const app = flags.app ?? args.app
    if (Boolean(app) === Boolean(flags.team)) this.error('Specify exactly one app or --team.')
    if (flags.supported && flags.unsupported) this.error('Specify at most one of --supported or --unsupported.')

    const data = new APIClient(this.config)
    suppressApiWarnings(data)
    data.defaults.host = 'api.data.heroku.com'
    data.defaults.protocol = 'https:'
    data.defaults.port = 443

    const metaData = new APIClient(this.config)
    suppressApiWarnings(metaData)
    metaData.defaults.host = 'shogun-meta.herokai.com'
    metaData.defaults.protocol = 'https:'
    metaData.defaults.port = 443

    suppressApiWarnings(this.heroku)
    const report = await new AddonsApi(this.heroku, data, metaData).report({app, team: flags.team})
    const addons = sortAddons(
      filterAddonsByLifecycle(report, flags.supported ? 'supported' : flags.unsupported ? 'unsupported' : undefined),
      flags.sort ?? (flags.team ? 'app' : 'name'),
    )
    this.log(flags.json ? JSON.stringify({addons}, null, 2) : formatAddonsTable(addons, {extended: flags.extended, includeApp: Boolean(flags.team)}))
  }
}

function suppressApiWarnings(client: APIClient): void {
  // The core API client writes Warning-Message response headers to stderr.
  ;(client.http as unknown as {showWarnings: () => void}).showWarnings = () => {}
}
