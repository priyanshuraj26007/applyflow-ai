# Testing ApplyFlow AI — start here

Thanks for helping test ApplyFlow AI! It spots hiring posts on LinkedIn, summarises the job, and drafts a
personalised application email that you can send from your own Gmail with your resume attached.

**Time needed:** about 15–20 minutes, once.
**Works on:** Windows and Mac, with Google Chrome.
**Your data stays on your laptop.** Your resumes, settings and Gmail login are stored only on your computer.
AI requests go to Groq/Gemini using **your own free key**. Nothing is shared with the person who invited you.

---

## Before you start
- [ ] **Google Chrome** installed.
- [ ] **Node.js (LTS)** installed: [nodejs.org/en/download](https://nodejs.org/en/download). Use the default options.
- [ ] **Gmail sending (optional):** send your Gmail address to the person who invited you, so they can add
      you as a tester. They'll send you back a **Client ID** and **Client Secret**. Keep these private.
      You can skip Gmail and copy the emails by hand instead.

## 1. Download
On the [Releases page](https://github.com/priyanshuraj26007/applyflow-ai/releases/latest), download
**Source code (zip)** and unzip it somewhere easy, for example your Desktop.

## 2. Run setup (one time)
| Windows | Mac |
|---|---|
| Open the unzipped folder and double-click **`setup.bat`**. | Open **Terminal**, type `cd ` (with a space), drag the unzipped folder into the window, press Enter, then run `bash setup.sh`. |

Setup installs everything and asks for:
1. **Your Groq key** (required, free). Setup opens [console.groq.com/keys](https://console.groq.com/keys):
   sign in → **Create API Key** → copy it (starts with `gsk_`) → paste it into setup.
2. **A Gemini key** (optional backup). Press Enter to skip.
3. **The Gmail Client ID and Secret** you were sent (optional). Press Enter to skip.

If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**. It's a plain script; you can open
`setup.ps1` in Notepad to read exactly what it does.

## 3. Start ApplyFlow and load the extension
1. **Start the backend:** Windows → double-click **`start.bat`**. Mac → `bash start.sh` in Terminal.
   Keep that window open whenever you use ApplyFlow. It should say *"ApplyFlow AI backend running"*.
2. In Chrome, open `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** →
   choose the **`extension`** folder inside the unzipped folder.
3. Pin it: click the puzzle icon in Chrome's toolbar → pin **ApplyFlow**.

## 4. Set it up for you (about 5 minutes)
Click the ApplyFlow icon → **Open Dashboard**.
1. **Resumes** → upload your resume as a PDF. Wait for **Ready**; the AI reads it once.
2. **Settings** → fill in your name, phone and LinkedIn URL.
3. **Settings → About me** (this is what makes the emails sound like you):
   **Copy the prompt** → paste it into ChatGPT, Claude or Gemini (whichever you use most) → copy its answer →
   paste it into the box → **Save settings**. After about 30 seconds you'll see **"✓ Ready"**.
4. **Settings → Email skeleton:** optional. This is the wording every email keeps; edit it if you like.
5. **Settings → Gmail → Connect Gmail** (only if you were sent the Client ID/Secret). Google will say
   *"Google hasn't verified this app"*. That's expected for a test app: click **Continue** and tick
   **Send email on your behalf**.

## 5. Use it
1. Browse your **LinkedIn feed**. When a hiring post scrolls by, a **"Hiring post detected"** card appears at the top right.
2. Click it to see a **job summary**: role, company, fresher or experienced, skills and requirements.
3. Click **Generate application** to get your best resume, a match score and a drafted email in a few seconds.
4. Edit anything, then **Send application → Confirm**. Nothing is ever sent without your confirm click.
   No Gmail? Open the full page with the **↗** button and use **Copy text**.

## If something goes wrong
| Problem | Fix |
|---|---|
| "ApplyFlow backend is not running" | Start it again (`start.bat` / `bash start.sh`) and keep the window open. |
| No card on LinkedIn | Refresh LinkedIn. After reloading the extension, LinkedIn tabs that were already open need a refresh. |
| "The AI is busy" | Groq's free tier allows roughly 2 drafts per minute. Wait a minute and click **Try again**. |
| "Port 3000 is already in use" | ApplyFlow is already running in another window. Close the extra window. |
| "Gmail access expired" | Settings → **Connect Gmail** again (test apps expire after 7 days). |

---

## 🗣️ Feedback: what to send me
Message me after you've tried it on **3 or more real job posts**. The most useful things are:
1. **Setup:** where did you get stuck or confused, and how long did it take?
2. **Detection:** did it miss any hiring posts? Copy the post text, or tell me if it was an image post.
3. **Job summary:** was anything wrong (role, company, fresher/experienced, requirements)?
4. **Emails, the most important part:** rate them **1–5**. Would you send them as they are? What did you change?
   Did they claim anything that isn't true about you?
5. **Speed:** did anything feel slow?
6. **Would you keep using it?** What's the one thing that would make you use it every day?

Screenshots help a lot. If something breaks, press **F12** on LinkedIn → **Console**, and send a screenshot
of any red lines or lines starting with `ApplyFlow AI:`.
