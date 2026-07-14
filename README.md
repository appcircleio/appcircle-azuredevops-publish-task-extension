## Appcircle Publish

Upload an application binary to an Appcircle **Publish** profile and/or trigger its publish flow (app store publishing) directly from your Azure DevOps pipeline.

Appcircle's **Publish to Stores** module gives you:

- **Centralized Store Publishing:** Manage App Store, Google Play, Huawei AppGallery, and Microsoft Intune releases from a single hub instead of navigating each platform separately.
- **Custom Publish Flows:** Automate your release cycle with repeatable publish flows and ready-to-use integrations tailored to your organization's needs.
- **Approval Gates:** Add manual approval steps to your publish flow to keep every release under control before it goes live.
- **Auto Re-sign:** Automatically apply updated signing credentials and versioning to uploaded binaries, keeping releases properly signed without a new build.
- **Audit and Reporting:** Track every publishing step with audit trails and publish reports for full transparency and compliance.

Learn more about [Appcircle Publish to Stores](https://appcircle.io/publish-to-stores?utm_source=azure&utm_medium=product&utm_campaign=publish).

## What the task does

The task has two independent switches (`upload` and `publish`) that both default to `false`. **You must enable at least one.** Create the Publish profile in Appcircle first; the task targets it by name (profile names are unique per platform).

| `upload` | `publish` | Behavior |
|:--------:|:---------:|----------|
| `true`  | `false` | Upload `appPath` as a new app version on the profile. |
| `false` | `true`  | Trigger the publish flow for the profile's **current release candidate**. |
| `true`  | `true`  | Upload `appPath`, **mark the new version as release candidate**, then trigger the publish flow for it. |
| `false` | `false` | Error: nothing to do. |

**Rules:**

- **In-progress guard:** if a publish is already running for the target profile, the task does **not** start a new one and fails fast.
- **Release candidate:** when both `upload` and `publish` are enabled, the freshly uploaded version is automatically marked as the release candidate before it is published. In publish-only mode, the profile's existing release candidate is published.
- **Progress:** while publishing, the task polls the publish status and prints step-by-step progress (with status icons) until the flow succeeds or fails.

> **Manual-approval steps:** if the profile's publish flow contains a manual step (e.g. "Get Approval via Email"), the flow waits for that action and the task keeps polling until it completes or the poll times out. For CI use, prefer publish flows without manual gates.

## How to use Appcircle Publish Extension

**Upload only:**

```yaml
- task: AppcirclePublish@0
  inputs:
    personalAPIToken: $(AC_PERSONAL_API_TOKEN)
    platform: ios # or android
    subOrganizationName: $(AC_SUB_ORGANIZATION_NAME) # optional
    publishProfile: $(AC_PUBLISH_PROFILE)
    upload: true
    appPath: $(AC_APP_PATH)
```

**Publish only (publishes the profile's current release candidate):**

```yaml
- task: AppcirclePublish@0
  inputs:
    personalAPIToken: $(AC_PERSONAL_API_TOKEN)
    platform: ios
    publishProfile: $(AC_PUBLISH_PROFILE)
    publish: true
```

**Upload and publish (uploads, marks it release candidate, then publishes):**

```yaml
- task: AppcirclePublish@0
  inputs:
    personalAPIToken: $(AC_PERSONAL_API_TOKEN)
    platform: android
    publishProfile: $(AC_PUBLISH_PROFILE)
    upload: true
    publish: true
    appPath: $(AC_APP_PATH)
```

### Inputs

- `personalAPIToken`: The Appcircle Personal API Token used to authenticate and authorize access to Appcircle services.
- `platform`: Target platform of the Publish profile: `ios` or `android`.
- `publishProfile`: Name of the Publish profile to target. Resolved to the profile for the selected platform.
- `upload` (default `false`): Upload `appPath` as a new app version.
- `publish` (default `false`): Trigger the profile's publish flow.
- `appPath`: Path to the application file. Required when `upload` is enabled. For iOS use a `.ipa` file; for Android use a `.apk` or `.aab` file.
- `authEndpoint` (optional): Authentication endpoint URL for self-hosted Appcircle installations. Defaults to `https://auth.appcircle.io`.
- `apiEndpoint` (optional): API endpoint URL for self-hosted Appcircle installations. Defaults to `https://api.appcircle.io`.
- `subOrganizationName` (optional): Sub-organization name for the publish profile. Leave empty to use the root organization. Use this when your Personal API Token belongs to the root organization but the target publish profile lives in a sub-organization.

> **Self-signed or private CA certificates:** If your self-hosted Appcircle server uses a self-signed certificate (or one issued by a private/internal CA), requests will fail certificate validation. The task does not disable TLS verification. Trust the server's CA on the build agent: set the `NODE_EXTRA_CA_CERTS` environment variable to a PEM file containing the CA certificate, or add the CA to the system certificate store.

## Further Details

For more detailed instructions and support, visit the [Appcircle Publish to Stores documentation](https://docs.appcircle.io/marketplace/visual-studio-marketplace/publish-to-stores).
