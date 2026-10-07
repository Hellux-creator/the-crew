# THE CREW: setup guide

THE CREW is a crew app for you and your mates: live map, convoys, garage, explored roads and a bass leaderboard. It runs on iPhone and Android as a home-screen app. It's free to run for a group of friends on Firebase's free Spark plan.

**Try it first:** open `public/index.html` through any local web server (or just deploy it, step 5). With no keys added it runs in **demo mode** with a pretend crew driving around Pretoria, so you can click through everything.

You need a computer for setup (about 20 minutes). After that, everyone only uses their phone.

---

## 1. Install the tools (once)

1. Install **Node.js** (LTS) from https://nodejs.org
2. Open a terminal (Mac: Terminal, Windows: PowerShell) and run:
   ```
   npm install -g firebase-tools
   firebase login
   ```

## 2. Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**. Name it something like `the-crew-app`. You can switch Google Analytics off.
2. In the left menu: **Build → Authentication → Get started**. Under **Sign-in method**, enable **Anonymous**. That's the only one you need: nobody signs up with an email or password. Each person just enters their name, phone number and car (make, model, year) the first time they open the app.
3. **Build → Firestore Database → Create database**. Pick location **africa-south1 (Johannesburg)** if it's offered, otherwise `europe-west1`. Choose **production mode**.

## 3. Add your keys to the app

1. In the Firebase console, click the gear icon → **Project settings** → scroll to **Your apps** → click the **</>** (Web) icon. Name it `THE CREW` and click **Register app**. You don't need Firebase Hosting setup from this screen.
2. Firebase shows a `firebaseConfig = { ... }` block. Copy those values into `public/firebase-config.js`, replacing the `PASTE_YOUR_API_KEY` placeholders.

(The web API key is safe to have in the app. What actually protects your data is the security rules in the next step.)

## 4. Connect this folder to your project

In the terminal, `cd` into the `the-crew` folder (the one with `firebase.json`) and run:
```
firebase use --add
```
Pick your project and give it the alias `default`.

## 5. Deploy

```
firebase deploy
```
This uploads the security rules and the app. At the end it prints a **Hosting URL** like `https://the-crew-app.web.app`. That's your app.

## 6. Install it on your phone

- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open it in **Chrome** → ⋮ menu → **Install app** (or **Add to Home screen**).

Open it from the home screen, tap **Get started**, fill in your name, phone number and car, then **Create crew**. Go to the **Crew** tab and tap **Share** to send your mates the link and the 6-letter invite code.

When the phone asks, **allow location** ("While using the app").

---

## How things work

| Feature | Notes |
|---|---|
| **Live map** | Your spot updates every few seconds while you're moving and the app is open. Pins fade after 5 minutes without an update and disappear after 2 hours. |
| **Ghost mode** | Tap the ghost button at the top. Your location is wiped from the crew map straight away and stops sending until you switch it off. |
| **Convoys** | Start one, tap the map to drop the destination pin. Everyone who joins sees each other's distance and ETA, with dashed lines to the 🏁. "Google Maps" and "Waze" buttons open turn-by-turn navigation. The screen stays on while you're in a convoy. |
| **Garage** | Add your cars with mods and a photo. The one marked "I'm driving this one now" shows next to your name on the map. |
| **Explore** | Every ~150 m square of road you drive gets cleared from the fog. The map button with three lines toggles the fog view. The crew leaderboard ranks who's driven the most new road. |
| **Bass** | Log sound-test scores in dB with class (Daily / Street / Extreme), frequency, setup, venue and a photo of the meter. The leaderboard shows each person's best score. Crew mates tap **I saw it** to confirm a run, and nobody can confirm their own. |

## Things to know

- **Only works while the app is open.** Phones (especially iPhones) stop web apps from tracking in the background. Keep it open on a phone mount during a convoy. It also saves your battery when you're not driving.
- **Phone numbers** are only visible to people in your crew. Tap someone on the map or in the Crew tab to call or WhatsApp them.
- **One phone per person.** Because there's no email login, your account lives on the phone you signed up on. If you delete the app's data or switch phones, you sign up again with the same name and number (your old explored-roads progress stays with the old account).
- **Privacy:** only people in your crew can see locations, phone numbers, convoys and bass scores. The rules in `firestore.rules` enforce that on Firebase's side, not just in the app.
- **Costs:** the free Spark plan allows 50,000 reads and 20,000 writes a day. A crew of about 10 driving for a few hours is well inside that. If you ever go over, things just pause until midnight (Pacific time). You won't get a bill unless you upgrade the plan yourself.
- **Map tiles** come from OpenStreetMap's free servers. That's fine for a group of friends. If the crew grows into the hundreds, switch to a paid tile provider (MapTiler or Stadia Maps both have free tiers) by changing the `L.tileLayer` URL in `app.js`.
- **Updating the app:** after you change any file, bump `VERSION` in `public/sw.js` (e.g. `thecrew-v5`) and run `firebase deploy` again. Phones pick up the new version the next time the app opens.
- **Removing someone:** the crew creator can delete their member entry in the Firebase console (Firestore → crews → your code → members). To lock everyone out, create a new crew and share the new code only with the people you want.

## Files

```
the-crew/
  firebase.json          hosting + rules config
  firestore.rules        who can read and write what
  SETUP.md               this guide
  public/
    index.html           the screens
    styles.css           the look
    app.js               the app logic
    geo.js               distance and explored-road maths
    store-firebase.js    talks to Firebase
    store-demo.js        the pretend crew for demo mode
    firebase-config.js   your keys go here
    sw.js                offline cache / installable app
    manifest.webmanifest app name and icon for the home screen
    icons/               app icons
```
