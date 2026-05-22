# Zoo Code Privacy Policy

**Last Updated: May 13th, 2026**

Zoo Code respects your privacy and is committed to transparency about how we
handle your data. Below is a simple breakdown of where key pieces of data
go—and, importantly, where they don't.

## **Where Your Data Goes (And Where It Doesn’t)**

- **Code & Files**: Zoo Code accesses files on your local machine when needed
  for AI-assisted features. When you send commands to Zoo Code, relevant files
  may be transmitted to your chosen AI model provider (e.g., OpenAI, Anthropic,
  OpenRouter) to generate responses. If you select Zoo Code Cloud as the model
  provider (proxy mode), your code may transit Zoo Code servers only to forward
  it to the upstream provider. We do not store your code; it is deleted
  immediately after forwarding. Otherwise, your code is sent directly to the
  provider. AI providers may store data per their privacy policies.
- **Commands**: Any commands executed through Zoo Code happen on your local
  environment. However, when you use AI-powered features, the relevant code and
  context from your commands may be transmitted to your chosen AI model provider
  (e.g., OpenAI, Anthropic, OpenRouter) to generate responses. We do not have
  access to or store this data, but AI providers may process it per their
  privacy policies.
- **Prompts & AI Requests**: When you use AI-powered features, your prompts and
  relevant project context are sent to your chosen AI model provider (e.g.,
  OpenAI, Anthropic, OpenRouter) to generate responses. We do not store or
  process this data. These AI providers have their own privacy policies and may
  store data per their terms of service. If you choose Zoo Code Cloud as the
  provider (proxy mode), prompts may transit Zoo Code servers only to forward
  them to the upstream model and are not stored.
- **API Keys & Credentials**: If you enter an API key (e.g., to connect an AI
  model), it is stored locally on your device and never sent to us or any third
  party, except the provider you have chosen.
- **Telemetry (Usage Data)**: We collect feature usage and error data to help
  us improve Zoo Code. This telemetry is powered by PostHog and includes your
  VS Code machine ID, feature usage patterns, and exception reports. The VS Code
  machine ID is a persistent identifier and may be considered personal data in
  some jurisdictions; we use it only for product analytics and error grouping.
  We retain telemetry only as long as needed for product analytics and debugging.
  Telemetry does **not** collect your code or AI prompts, and you can opt out at
  any time through the settings.
- **Zoo Code Observability (Authenticated Subscribers Only):** If you sign in to
  Zoo Code and have an active subscription, Zoo Code will send LLM usage
  telemetry to the Zoo Code backend (zoocode.dev). This includes task ID, AI
  provider name, model name, token counts (input/output/cache), and estimated
  cost. This data is linked to your authenticated Zoo Code account. You can stop
  this collection at any time by signing out via the Zoo Code badge in the chat
  area.
- **Marketplace Requests**: When you browse or search the Marketplace for Model
  Configuration Profiles (MCPs) or Custom Modes, Zoo Code makes a secure API
  call to Zoo Code's backend servers to retrieve listing information. These
  requests send only the query parameters (e.g., extension version, search term)
  necessary to fulfill the request and do not include your code, prompts, or
  personally identifiable information.

## **How We Use Your Data (If Collected)**

- We use telemetry to understand feature usage and improve Zoo Code.
- We do **not** sell or share your data.
- We do **not** train any models on your data.

## **Your Choices & Control**

- You can run models locally to prevent data being sent to third-parties.
- Telemetry collection is enabled by default to help us improve Zoo Code, but
  you can opt out at any time through the settings.
- You can delete Zoo Code to stop all data collection.

## **Security & Updates**

We take reasonable measures to secure your data, but no system is 100% secure.
If our privacy policy changes, we will notify you within the extension.

## **Contact Us**

For any privacy-related questions, reach out to us at support@zoocode.dev.

---

By using Zoo Code, you agree to this Privacy Policy.
