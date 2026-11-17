# Firebase Data Dashboard

A local dashboard for inspecting Firebase device data, managing services and database rotation, and using the provider-compatible SMS API.

## Requirements

- Node.js 18 or newer
- A Firebase Realtime Database URL

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create a `.env` file in the project directory with a separate dashboard API key, admin key, and Firebase URL:

   ```dotenv
   DASHBOARD_API_KEY=replace_with_a_private_api_key
   DASHBOARD_ADMIN_KEY=replace_with_a_different_private_admin_key
   FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
   PORT=3000
   ```

   Generate each key independently with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Keep `.env` private; it is excluded from Git. The admin key is used to sign in to the dashboard, while the dashboard API key is used by provider-compatible API URLs.

3. Start the dashboard:

   ```powershell
   npm start
   ```

4. Open `http://127.0.0.1:3000` and sign in with `DASHBOARD_ADMIN_KEY`. The signed-in session persists for 30 days on that browser.

Local service and rotation configuration files are also excluded from Git.