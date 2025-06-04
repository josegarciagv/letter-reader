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

A local `.env` file can also be used for development. If the file does not exist,
`server.js` will fall back to using the variables provided by the environment.
