# Testing ApplyFlow: start here

Thanks for helping test ApplyFlow! It spots hiring posts on LinkedIn, summarises the job, and writes a
personalised application email that you send from your own Gmail with your resume attached.

👉 **The easiest way: open [applyflow-ai-murex.vercel.app](https://applyflow-ai-murex.vercel.app)**, which has the
download and an interactive step-by-step setup guide. The same steps are below.

**Time needed:** about 5 minutes, once.
**Works on:** Google Chrome, Microsoft Edge or Brave, on Windows or Mac.
**Cost:** nothing. ApplyFlow, the AI key and Gmail are all free. You'll never be asked for a card.

---

## Before you start
- [ ] **Send your Gmail address** to the person who invited you, so they can add you as a Gmail tester.
      (You can do everything else meanwhile; only "Connect Gmail" needs this.)

## 1. Install the extension
1. **Download** `ApplyFlow-extension.zip` from the [website](https://applyflow-ai-murex.vercel.app/#download).
2. **Unzip it.** Windows: right-click → **Extract All…** → **Extract**. Mac: double-click it.
   Move the **ApplyFlow** folder somewhere it can stay (e.g. Documents). Don't delete it later.
3. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
4. Turn on **Developer mode** (top right) → **Load unpacked** → select the **ApplyFlow** folder.
5. Click the 🧩 puzzle icon in the toolbar → **pin** ApplyFlow.

> If Chrome later says *"Disable developer mode extensions"*, just close that message.

## 2. Get your free AI key (1 minute)
1. Open [console.groq.com/keys](https://console.groq.com/keys) and sign in (**Continue with Google** is quickest).
2. **Create API Key** → any name → **Submit** → **copy** it (starts with `gsk_`; Groq shows it only once).
3. Click the ApplyFlow icon → **Open Dashboard** → **Settings** → paste it under **Your AI key** → **Save**.
   You should see **✓ Groq key works**.

No card, no billing: Groq's free plan just has a speed limit (about two emails a minute).

## 3. Set it up for you (about 3 minutes)
1. **Resumes** → upload your resume as a PDF (several versions welcome). Wait for **Ready**.
2. **Settings** → check your **name, phone, LinkedIn** (suggested from your resume) → **Save**.
3. **Settings → About me** → **Copy the prompt** → paste it into ChatGPT, Claude or Gemini (whichever you use
   most) → paste its answer into the box → **Save**. After a minute it shows **✓ Ready**.
4. **Settings → Connect Gmail** (once you've been added as a tester). Google says *"Google hasn't verified this
   app"*, which is expected for a test app: click **Continue**, then tick **Send email on your behalf**.

## 4. Use it
1. Open (or refresh) your **LinkedIn feed** and scroll. A **"Hiring post detected"** notification appears at
   the top right; the **‹ ›** arrows step through older posts.
2. Click it for the **job summary**, then **Generate application** for your best resume + a written email.
3. Edit anything, then **Send → Confirm**, or use the **🕒** button to **send later**.
   Nothing is ever sent without your click. Everything is tracked in the Dashboard.

## If something goes wrong
| Problem | Fix |
|---|---|
| No notification on LinkedIn / "please refresh this LinkedIn page" | Refresh LinkedIn (F5), especially after updating or reloading ApplyFlow. |
| "Add your free Groq API key" | Dashboard → Settings → **Your AI key** (step 2). |
| "The AI is busy" | Groq's free speed limit. Wait a minute and try again. |
| "Gmail access expired" | Settings → **Connect Gmail** again (test apps must reconnect every 7 days). |
| "Access blocked" when connecting Gmail | You haven't been added as a tester yet: send your Gmail address to whoever invited you. |
| Dashboard shows **Offline** | Check your internet; it reconnects by itself. |

## Updating to a new version
Download the new zip, replace the contents of your **ApplyFlow** folder with the new files, then click
**↻ reload** on ApplyFlow in `chrome://extensions` and refresh LinkedIn. Your data is kept.

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
