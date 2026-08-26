# heroku-data-extras

Heroku CLI plugin that generates a report about Heroku Data add-ons.

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

The command displays a table for Heroku Postgres, Redis, and Kafka add-ons.
* Team reports include the app name and sort by app name by default.
* Use `--json` to emit the report as JSON.
* Use `--supported` or `--unsupported` to filter by version lifecycle status.
* Use `--extended` to display full plan names and maintenance timestamps.
* Use `--sort name`, `--sort app`, or `--sort version` to choose the sort order.

The command uses your existing Heroku CLI login. Run `heroku login` if you are
not already authenticated; the logged-in account needs access to the selected
app or team.