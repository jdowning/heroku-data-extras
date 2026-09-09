# heroku-data-extras

Heroku CLI plugin that generates an operational report about Heroku Data add-ons.

## Install

```sh
git clone https://github.com/jdowning/heroku-data-extras
cd heroku-data-extras
heroku plugins:link .
```

## Usage

```sh
heroku data:report --app my-app
heroku data:report --team my-team
heroku data:report --app my-app --json
heroku data:report --team my-team --unsupported
heroku data:report --team my-team --extended
heroku data:report --team my-team --sort version
```

Specify exactly one of `--app`/`-a` or `--team`.

The command reports Heroku Postgres, KVS, and Kafka add-ons, including each
add-on's plan, engine version, lifecycle status, and maintenance status. Team
reports include all matching apps, identify which app owns each add-on, and sort
by app name by default.
* Use `--json` to emit the report as JSON.
* Use `--supported` or `--unsupported` to filter by version lifecycle status.
* Use `--extended` to display full plan names and maintenance timestamps.
* Use `--sort name`, `--sort app`, or `--sort version` to choose the sort order.

The command uses your existing Heroku CLI login. Run `heroku login` if you are
not already authenticated; the logged-in account needs access to the selected
app or team.
