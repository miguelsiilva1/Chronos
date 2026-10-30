<p align="center">
  <img src="icons/icon.svg" alt="" width="96" height="96">
</p>

<h1 align="center">Chronos</h1>

<p align="center">A minimal calendar for Google Calendar, installable as an app.</p>

<p align="center"><a href="https://miguelsiilva1.github.io/Chronos/"><strong>Open Chronos</strong></a></p>

![Week view, light theme](docs/week-light.png)

![Month view](docs/month-light.png)

![Week view, dark theme](docs/week-dark.png)

The screenshots show demo mode.

## Why

Google Calendar does a lot, and its interface shows all of it. Chronos keeps the part used every day: a clean view of your time, across all your Google accounts, in one window. It is a static site with no server and no build step, so anyone can host a copy for free.

## Features

- Day, week and month views, with the week starting on Monday and a 24-hour clock
- Red "now" line in the day and week views, updated every minute
- Drag in a column to create an event, snapped to 15 minutes
- Several Google accounts at the same time, with calendars grouped by account
- Create, edit, delete and move events between calendars and accounts
- Only one occurrence changes when you edit or delete a repeating event
- Mini calendar and show or hide controls for each calendar
- Sync on focus and every 5 minutes
- Keyboard shortcuts
- Automatic light and dark themes
- Responsive layout, with a drawer sidebar on phones
- Installable as a PWA, and the app shell opens offline
- Demo mode with sample calendars when no client ID is set
- Portuguese (Portugal) interface

## Getting started

### Host on GitHub Pages

1. Fork this repository.
2. Open **Settings > Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Select the `main` branch and the `/ (root)` folder, then click **Save**.

The app runs in demo mode until you add a client ID.

### Run locally

```bash
python -m http.server 8000
```

Open <http://localhost:8000>.

### Create the OAuth client

Do these steps in the [Google Cloud console](https://console.cloud.google.com/).

1. Create a project.
2. Open **APIs & Services > Library** and enable the **Google Calendar API**.
3. Open the **OAuth consent screen**, choose **External** and add your Google accounts as **test users**.
4. Add these scopes:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `openid`
   - `email`
5. Open **Credentials** and create an **OAuth client ID** of type **Web application**.
6. Add these **Authorized JavaScript origins**:
   - `https://miguelsiilva1.github.io`
   - `http://localhost:8000`
7. Copy the client ID into `config.js`:

   ```js
   window.GOOGLE_CLIENT_ID = "your-client-id.apps.googleusercontent.com";
   ```

If you host your own copy, use your own origin in step 6. The client ID is public by design, so it is safe to commit. There is no client secret.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next |
| `T` | Today |
| `D` | Day view |
| `S` | Week view (*semana*) |
| `M` | Month view |
| `N` | New event |
| `Esc` | Close |

Shortcuts are off while you type in a field.

## How it works

| File | Role |
| --- | --- |
| `index.html` | Page structure and the event editor dialog |
| `styles.css` | Design tokens, themes and layout |
| `app.js` | Views, Google sign-in, Calendar API calls and demo mode |
| `config.js` | The Google client ID |
| `manifest.webmanifest` | PWA name, icons and display mode |
| `sw.js` | Caches the app shell, network first. It never touches Google requests |
| `icons/` | App icon as SVG and PNG |
| `docs/` | Screenshots for this README |

The browser signs in directly with Google Identity Services and calls the Calendar API. No other server sees your data.

## Limitations

- **Sessions last 1 hour.** The browser-only token model has no refresh tokens, so renewal needs a backend. When a token expires, Chronos keeps your calendar list and shows **Sessão expirada · reativar** at the top. Each click renews one account.
- **Tokens stay in `localStorage`.** Anyone with access to your browser profile can read a token until it expires. Do not use Chronos on a shared computer.
- **Test mode is limited to your test users.** Wider use needs Google's app verification.
- **Moving a repeating occurrence creates a new event.** The Calendar API cannot move a single instance, so Chronos creates a one-off event and deletes that occurrence. The same applies to moves between accounts. Guests and attachments are not copied.

## License

[MIT](LICENSE)
