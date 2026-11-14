# Use Talaria on a phone

Talaria is made for a phone first. This page shows how to open your hub on a phone, put it on the Home Screen as an
app, sign in, and get a notice when the agent needs you. It takes about five minutes once your hub has an HTTPS address.

A phone is not paired the way a computer is. A computer gets a device token and runs commands for the agent (see
[Add a computer](../start/add-a-computer.md)). A phone only shows your chats, so it just signs in to the hub with
your account. It does not appear under Settings, Computers. The one thing that is linked in steps is notifications,
and optionally Telegram.

## What you need

- A running hub and an account on it: [Pick an install](../deploy/getting-started.md).
- An address that the phone can reach. `http://localhost:8080` works only on the server itself, so use the
  hub's public address (`TALARIA_PUBLIC_URL` in compose, `publicUrl` in Helm), for example
  `https://talaria.example.com`. If the server is at home, reach it over a VPN or tunnel that is also on the phone
  (Tailscale, WireGuard).
- HTTPS for the app and for notifications. On plain `http://<LAN address>:8080` the chat works in the phone's
  browser, but the browser does not offer to install the app and does not offer push. See
  [Reach it from other computers](../deploy/compose.md#reach-it-from-other-computers). If the hub uses a certificate from
  your own authority (`TALARIA_TLS=internal`), install and trust its root certificate on the phone first.
- A phone browser with push: Chrome or Firefox on Android, or Safari on iOS 16.4 or later.

## Step 1: Open the hub and sign in

1. Open the hub's address in the phone's browser. It shows the login page.
2. Sign in with the user name and password of your account, or as the login your admin set up asks (OpenID Connect or a login proxy; see [Set up logins](../deploy/auth.md)).
   Ask the admin for an account if you do not have one; the first account is made on the setup page of a new hub.
3. The chat list shows. Chats you started on a computer or in Telegram are all here.

On a phone the page shows one pane at a time: the chat list, a chat, or Settings with a back arrow. The gear in the top
bar opens Settings.

## Step 2: Put it on the Home Screen

The hub is a progressive web app: it has a manifest (name "Talaria", opens full screen without the browser's address bar), icons, and a
small service worker. Installing it gives you a Talaria icon and a window of its own.

- **Android, Chrome:** open the browser menu and choose **Install app** (or **Add to Home screen**).
- **Android, Firefox:** open the browser menu and choose **Install**.
- **iPhone and iPad, Safari:** tap **Share**, then **Add to Home Screen**, then **Add**. Open the hub from the new icon
  from now on. On iOS this step is required for notifications.

Menu names differ a little between browser versions. Some phones keep the installed app's login apart from the browser's, so you may have to sign in again the first time you open it.

What the app does without a network: it shows an offline page ("You are offline") and nothing else. It never keeps your
chats, API answers or event streams on the phone; those need the login and the hub. Your chats keep running on the server
while the phone is offline, and are there when you reconnect. When the hub has a new release, the app loads it by itself
after a minute without input, so you do not update it.

## Step 3: Turn on notifications

Open the app (on iOS, the Home Screen icon, not Safari) and:

1. Tap the gear, then **Notifications**.
2. Choose the events you want. Approvals, questions and failures are on by default; long tasks done and scheduled jobs
   are off.
3. Under **Where**, keep **Browser and app notifications** on.
4. Tap **Turn on for this device** and allow notifications when the phone asks.
5. Tap **Send a test**. A notice should arrive within a few seconds. The page says how many devices and Telegram chats it sent to.

![Settings, Notifications: the events to notify about, the channels (Telegram and browser notifications), and a Turn on for this device button](../deploy/images/settings-notifications.png)

Then:

- A notice shows only the kind of event, a fixed title such as "Talaria needs your approval", and the name of the agent server. It never shows the chat's title, a command or a question. Tap it to open that chat.
- You get no notice for a chat that is open on a visible screen. A question that waits for 5 minutes gets one reminder.
- **Quiet hours** set a time range in which nothing is sent. They use the phone's time zone.
- The list under the button shows every device you turned on, with **Remove**. Tap **Turn off on this device** here to stop this phone. You can have up to 10 devices.
- **Log out** in Settings, Account also turns off notifications on that device, so the next person who signs in on it gets nothing meant for you.

Notifications work even when the app is closed. They are sent by the phone's own push service (Google, Mozilla or Apple), which the server must reach
over HTTPS; see [Notifications](../deploy/notifications.md) for the addresses.

## Step 4 (optional): Link Telegram

If your admin turned on the Telegram bot ([Telegram](../deploy/telegram.md)), you can chat from Telegram as well. In Telegram, send the bot `/link`, open the link it sends you, sign in to the hub if asked and confirm. Settings, Telegram then
says "Linked". Notices also arrive in Telegram, with buttons to approve or deny, and this works on a hub that has no HTTPS address.

## If it does not work

- **No Install option:** the page is not on HTTPS, or the browser does not support installing. Check the address bar for `https://`.
- **No "Turn on for this device" button:** the page says "Browser notifications are not set up on this hub" (the admin must check the Web Push key), or the page is not on HTTPS.
  On an iPhone with Safari it says to use the Home Screen app: add it as in step 2 and open it from there.
- **"Notifications are blocked for this site":** allow them in the phone's settings for the browser or the app, then tap the button again.
- **The test reaches Telegram but not the phone:** the phone blocked notifications for the site, or battery saving puts the app to sleep. Allow notifications and exempt the app from battery saving.
- **A Chromium browser without Google services** (some Android builds and desktop packages) cannot subscribe: use Google Chrome or Firefox.

More in [Fix server problems](../deploy/troubleshooting.md#notifications-do-not-arrive).
