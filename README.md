# letter-reader

This project is a Node.js server that analyzes letters or documents using OpenAI.

## Environment Variables

The server reads configuration from environment variables. When deploying to platforms such as Railway,
set the following variables in your project settings:

- `PORT` – Port the server should listen on.
- `OPENAI_API_KEY` – API key for OpenAI.
- `STRIPE_SECRET_KEY` – Stripe secret key for payments.
- `STRIPE_WEBHOOK_SECRET` – Stripe webhook signing secret.
- `DOMAIN` – Base URL for the frontend (used in payment redirects).
- `MONGO_URL` or `MONGODB_URI` – MongoDB connection string.
- Sessions are stored in the `sessions` collection and expire after 24 hours.

Authentication relies on a bearer token returned by `POST /api/session`. Clients
must include `Authorization: Bearer <token>` on all subsequent API requests.

Configure your Stripe dashboard to send events to `<your-domain>/webhook`. The
client also verifies the payment on page load using `/api/check-payment` as a
fallback in case the webhook fails.

A local `.env` file can also be used for development. If the file does not exist,
`server.js` will fall back to using the variables provided by the environment.

## Token Pricing

| Paquete de Tokens | Precio | Precio por Token | Ideal para... |
| ----------------- | ------ | ---------------- | ------------- |
| 5 tokens | $2.99 | $0.60 | pruebas / uso ocasional |
| 10 tokens | $4.99 | $0.50 | uso moderado |
| 25 tokens | $9.99 | $0.40 | usuarios frecuentes |
| 50 tokens | $17.99 | $0.36 | negocios pequeños |
| 100 tokens | $29.99 | $0.30 | uso intensivo / oficinas |
