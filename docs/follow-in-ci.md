# Follow in CI

`follow` moves a story when its pull request merges: it closes the story through the close gate, or puts a stale review back to in-progress ([how it works](how-it-works.md)). Run by hand, it needs a person at a terminal or a session. The package also ships a GitHub Actions workflow, [`templates/follow-github-actions.yml`](../templates/follow-github-actions.yml), that does the same in your code repository's CI after every merge, with nobody running a command.

ProjectStore never installs that file, never runs it and never reads its token. You copy it, you set it up, and you can delete it at any time.

## When to use it

Use it when all of these hold:

- the vault is a git repository with a remote on GitHub, and the vault is that repository's root (its `epics/` folder sits at the top);
- the code repository is on GitHub, and its CI may push to the vault's repository with a token you give it;
- you link stories to pull requests already, through a story's `external_refs.pr` or a `Closes-story:` line in a pull request's description.

Do not use it when the vault is a synced folder with no remote (iCloud, Dropbox, a network drive): there is nothing for CI to clone or push. Run `follow` by hand there. The template is written and checked for GitHub only.

Before you copy it, run `follow` once by hand in the project, without `--write`. It prints the moves it would make and writes nothing, so you see what CI will do:

```
npx projectstore follow
```

## What the job does

On each push to the default branch (a merged pull request is one), the job:

1. checks the settings below, before anything else, and stops with a message that names the missing one;
2. checks out the code repository, with no credentials kept;
3. sets up Node.js 24;
4. clones the vault's repository into the job's scratch folder, with the vault token sent as a header on that one command;
5. binds the job to that clone (`bind --rebind`); the binding lands in the job's own copy of the code and is thrown away with it. The `bind` step's output ends with a hint to scaffold the layout's missing folders: that is expected in CI, and nothing needs doing about it;
6. runs `follow --write`, which reads the pull requests through `gh` with the run's own token, then moves stories, closes epics and regenerates the board and the other views;
7. commits what follow changed, as `github-actions[bot]` with the message "follow: update the vault after a merge", and pushes it to the vault, never forced;
8. ends with follow's exit code: green when follow found nothing wrong, red when it reported a finding.

Only stories, epics, the derived views (the board, the graph, the code map, the flow page, the spec tree) and the folder indexes are committed. Nothing under `.projectstore/` and no other file is.

## Set it up

1. Copy the template into the code repository as `.github/workflows/projectstore-follow.yml`.
2. If the code repository's default branch is not `main`, edit the branch line under `on: push:` first. Otherwise the workflow never runs, and nothing tells you.
3. Create the vault token (next section) and store it as a repository secret named `PROJECTSTORE_VAULT_TOKEN`.
4. Store the vault's clone URL as a second repository secret, `PROJECTSTORE_VAULT_REMOTE`, and add the two repository variables below, under Settings, Secrets and variables, Actions.
5. Merge something, or start the workflow by hand from the Actions tab (`workflow_dispatch`). A run by hand is also how you catch up after fixing a setting, or when the file lands after merges that already happened: follow works every move out from the pull requests again.

| Setting | Kind | Required | Holds |
|---|---|---|---|
| `PROJECTSTORE_VAULT_TOKEN` | secret | yes | a token that can write to the vault repository and nothing else |
| `PROJECTSTORE_VAULT_REMOTE` | secret | yes | the vault's `https://` clone URL, with no user name or token in it; a secret, so the log never shows it |
| `PROJECTSTORE_VAULT_LANGUAGE` | repository variable | yes | the vault's template language, as `bind --language` takes it (`en`, `de`, `ru` and so on); follow rewrites the board in it |
| `PROJECTSTORE_VAULT_BRANCH` | repository variable | no | the vault branch to push; empty means the remote's default branch |

The workflow reads them only as expressions in its `env:` blocks, for example:

```yaml
env:
  VAULT_TOKEN: ${{ secrets.PROJECTSTORE_VAULT_TOKEN }}
  VAULT_REMOTE: ${{ secrets.PROJECTSTORE_VAULT_REMOTE }}
  VAULT_LANGUAGE: ${{ vars.PROJECTSTORE_VAULT_LANGUAGE }}
```

## The vault token

The token is the one thing in this setup that can change your vault, so keep it as small as GitHub allows. Use a fine-grained personal access token with:

- repository access: only the vault repository, no other;
- repository permissions: `Contents` read and write, and nothing else (GitHub adds `Metadata` read by itself);
- an expiry date you will notice.

Such a token belongs to a person and expires. When it lapses, the job goes red at the clone, not at the settings check, because an expired token is not an empty one. Create a new one and replace the secret. In an organisation that uses single sign-on, authorise the token for that organisation, or GitHub refuses it. If the vault's branch is protected so that changes need a pull request, the push is refused: let the token's owner push to that branch, or point `PROJECTSTORE_VAULT_BRANCH` at a branch they may push.

The job hands the token to git alone: as a header on the clone and on the push, never in a URL, never in the clone's `.git/config`, and never in the steps that run `npx`. The log shows it masked.

Two ways to make it harder to misuse:

- Store the token as an environment secret instead, in an environment whose deployment branches are limited to the default branch, and add `environment: <its name>` to the job. Then a workflow on another branch cannot read it. Without this, anyone who can push a branch to the code repository can add a workflow of their own that reads the secret.
- Add a code owner for `.github/workflows/`, so a change to the workflow needs that owner's review.

## A private vault and a public code repository

If your vault is private and your code repository is public, two places can leak story names.

- A `Closes-story: <EPIC>/<story-id>` line in a public pull request's description puts the story's id, a whole sentence of your backlog, in public. Link the story from the vault side instead: put the pull request's URL in the story's `external_refs.pr`.
- The job log of a public repository is public, and follow's output names story ids, titles and the text of unchecked criteria. So the workflow prints follow's output only when the repository is private. Anywhere else it prints follow's exit code and one sentence saying that the output is withheld. The commit message names no story either. The vault's URL is a secret too, so GitHub masks it everywhere in the log, git's own error messages included. GitHub masks the secret's whole value. A git error can still name the vault's host on its own. If the vault repository is renamed, git may print its new address, which the mask does not cover. Update the secret.

## Forks, Dependabot and other repositories

- Disable the workflow in a fork. A fork's runs get no secrets, so they would only fail at the settings check.
- A run that Dependabot starts gets no Actions secrets either, so it stops at the first step with "The secret PROJECTSTORE_VAULT_TOKEN is not set". That is expected; the next merge runs it again.
- The run's own token reads only this repository's pull requests. A story whose `external_refs.pr` names a pull request in another private repository cannot be read: follow reports `pr-unreadable`, and the job stays red on every run until that link changes, while the other moves are still pushed.

## Which release it runs

The template runs the ProjectStore release it came with: both of its `npx` lines name that version, as `projectstore@<version>`. A newer ProjectStore does not change your copy. To move it to another release, copy the template of that release again, or edit the version in both `npx` lines yourself.

The pin matters for safety too. All steps of one job share one machine, so code that `npx` runs could tamper with the later push step. The pin limits that to the release a person chose to copy.

## When the job is red

A red job means one of these. In a private repository the job's log says which. In a public one follow's output is withheld, so its exit code says which: the last lines of the follow step print it, 1 for a finding, 2 for a usage error (the `bind` step also exits with 2 on an unknown language), 3 when the job is not bound. To see the findings themselves, run follow locally in the project, without `--write`; it writes nothing:

```
npx projectstore follow
```

The causes:

- a setting is missing or malformed: the first step names it;
- the clone failed: the token lapsed, lacks access, or the URL or branch is wrong;
- `bind` refused the language (an unknown one exits with code 2);
- follow reported a finding, such as a pull request it could not read; the moves it could make are still pushed;
- the push was refused: someone pushed to the vault while follow ran, or the token cannot write to that branch. Nothing is ever forced.

Fix the cause, then re-run the job from the Actions tab. A re-run is safe: follow works out the same moves again from the pull requests, and when the vault already says what they say, the job pushes nothing.

## Turn it off

Disable the workflow in the Actions tab, or delete the file. Then revoke the vault token and delete the two secrets, `PROJECTSTORE_VAULT_TOKEN` and `PROJECTSTORE_VAULT_REMOTE`. The commits the job already pushed stay in the vault's history. Nothing was installed, so there is nothing else to remove.
