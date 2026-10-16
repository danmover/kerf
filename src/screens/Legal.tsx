// Terms, privacy, acceptable use and open-source notices.
// Every policy here is a DRAFT written for the prototype. It has not been
// reviewed by a lawyer and must be before Kerf is offered to the public.

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { go, useUi, type LegalDoc } from "../app/ui";
import { useProject } from "../app/project";
import { TERMS_VERSION } from "../app/settings";
import { Logo } from "../ui/Logo";
import { Icon } from "../ui/icons";

const UPDATED = "16 October 2026";

const DOCS: { id: LegalDoc; label: string }[] = [
  { id: "terms", label: "Terms of Service" },
  { id: "privacy", label: "Privacy notice" },
  { id: "acceptable-use", label: "Acceptable use" },
  { id: "licenses", label: "Open-source licences" },
];

export function Legal() {
  const screen = useUi((s) => s.screen);
  const hasProject = useProject((s) => !!s.current);
  if (screen.name !== "legal") return null;
  const back = screen.back === "workspace" && !hasProject ? "home" : screen.back;
  const doc = screen.doc;
  return (
    <div className="screen">
      <div className="backdrop-grid" />
      <div className="legal">
        <div className="row" style={{ gap: 12 }}>
          <button className="btn ghost" onClick={() => go({ name: back } as never)}>
            <Icon.Chevron size={14} style={{ transform: "rotate(180deg)" }} /> Back
          </button>
          <div className="grow" />
          <Logo size={20} />
        </div>
        <nav className="row" style={{ gap: 6, marginTop: 18, flexWrap: "wrap" }} aria-label="Legal documents">
          {DOCS.map((d) => (
            <button key={d.id} className={`chip ${doc === d.id ? "accent" : ""}`} style={{ cursor: "pointer", height: 26, padding: "0 10px" }} onClick={() => go({ name: "legal", doc: d.id, back: screen.back })}>
              {d.label}
            </button>
          ))}
        </nav>
        <motion.article key={doc} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          {doc === "terms" && <Terms />}
          {doc === "privacy" && <Privacy />}
          {doc === "acceptable-use" && <AcceptableUse />}
          {doc === "licenses" && <Licenses />}
        </motion.article>
      </div>
    </div>
  );
}

function Draft() {
  return (
    <div className="draft" role="note">
      <Icon.Alert size={16} />
      <div>
        <b>Draft for the prototype. Not reviewed by a lawyer.</b> This text describes how the prototype actually behaves, but it has not had legal review and must be reviewed before Kerf is offered to anyone outside the team. Version {TERMS_VERSION}, last updated {UPDATED}.
      </div>
    </div>
  );
}

function Doc({ title, children, draft = true }: { title: string; children: ReactNode; draft?: boolean }) {
  return (
    <>
      <h1>{title}</h1>
      {draft ? <Draft /> : <p className="dim">Last updated {UPDATED}.</p>}
      {children}
    </>
  );
}

function Terms() {
  return (
    <Doc title="Terms of Service">
      <h2>1. What Kerf is</h2>
      <p>Kerf is a prototype design tool. It runs in your web browser, builds 3D models from a design file, checks them, and lets an AI model (Claude, by Anthropic) edit that design file when you ask it to. Some copies of Kerf are served by a Kerf server that also offers accounts; others run entirely in your browser. By using Kerf you agree to these terms.</p>
      <h2>2. Prototype status</h2>
      <p>Kerf is early software provided for evaluation. Features may change or be removed, and it may contain errors. Keep your own copies of anything important by exporting it.</p>
      <h2>3. Your designs</h2>
      <p>You own the designs you create. Without an account, Kerf stores them only in your browser and nobody else receives a copy; clearing your browser data deletes them. If you sign in to a Kerf account, the projects you add to it, with their version history and chats, are also stored on the Kerf server so they can sync between your devices. You allow whoever runs that server to store and transmit them only to provide Kerf to you.</p>
      <h2>4. Accounts</h2>
      <ul>
        <li>Use an email address you control, and keep your password to yourself. You are responsible for what happens in your account.</li>
        <li>You can download everything in your account and delete it at any time from Settings → Account. Deleting it removes your projects, history, chats and saved Claude key from the server straight away; copies in the server's backups go when those backups expire.</li>
        <li>Whoever runs the server can suspend an account that breaks these terms or the Acceptable use policy, or that puts the service at risk.</li>
      </ul>
      <h2>5. Engineering responsibility</h2>
      <ul>
        <li>The checks Kerf runs (interference, clearances, tool access, gear meshing, motion and your own requirements) are aids. They do not cover strength, fatigue, thermal behaviour, tolerances of a specific machine or material, or regulatory requirements.</li>
        <li>AI output can be wrong even when it sounds confident. Review every change, inspect the geometry, and test physical parts before relying on them.</li>
        <li>Do not use Kerf as the only basis for parts where failure could injure people or damage property.</li>
      </ul>
      <h2>6. Your Claude API key</h2>
      <p>The AI features use your own Anthropic API key. Without an account, requests go directly from your browser to Anthropic. If you save the key to your Kerf account, it is stored encrypted on the Kerf server, and your requests go through that server, which adds the key and passes them to Anthropic. Either way, usage is billed to your Anthropic account and governed by Anthropic's own terms and usage policies as well as these, and you are responsible for keeping the key secure.</p>
      <p>If the server lets your account use a key it provides instead, that use is limited to the daily allowance shown in Settings and can be changed or withdrawn at any time.</p>
      <h2>7. Acceptable use</h2>
      <p>You agree to follow the Acceptable use policy, including not using Kerf to design weapons or anything intended to cause harm.</p>
      <h2>8. Third-party software</h2>
      <p>Kerf includes open-source components under their own licences, listed on the Open-source licences page.</p>
      <h2>9. No warranty</h2>
      <p>To the extent the law allows, Kerf is provided "as is", without warranties of any kind, including fitness for a particular purpose or that the service will be available or free of data loss, and the people who make or run it are not liable for losses arising from its use, including lost designs or the performance of manufactured parts.</p>
      <h2>10. Changes</h2>
      <p>If these terms change, Kerf will show the new version and ask you to accept it before you continue.</p>
      <h2>11. Contact</h2>
      <p>Contact details will be added before public launch.</p>
    </Doc>
  );
}

function Privacy() {
  return (
    <Doc title="Privacy notice">
      <h2>The short version</h2>
      <p>Without an account, Kerf has no server: your designs, history, chats and settings stay in this browser, and when you chat with Claude your browser sends the conversation directly to Anthropic's API using your key. If you sign in to a Kerf account, the projects you add to it are also kept on the Kerf server so they sync between your devices, and you can keep your Claude key there instead of in the browser. If you talk to Claude with voice input, your speech is turned into text on your device when the browser can; otherwise your browser's own speech service hears it, and only if you allow that. Kerf has no analytics, tracking or advertising, with or without an account.</p>
      <h2>In this browser</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Where it lives</th>
            <th>How to remove it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Designs, version history and thumbnails</td>
            <td>IndexedDB in this browser</td>
            <td>Delete the project, or Settings → Data → Clear all data</td>
          </tr>
          <tr>
            <td>Chat history for each project</td>
            <td>IndexedDB in this browser (screenshots sent to Claude are not kept)</td>
            <td>Clear the chat, delete the project, or clear all data</td>
          </tr>
          <tr>
            <td>Preferences (model, display and voice options, terms version accepted) and sync bookkeeping</td>
            <td>localStorage in this browser</td>
            <td>Clear all data</td>
          </tr>
          <tr>
            <td>Voice audio</td>
            <td>Not recorded or kept. The browser turns speech into text, and Kerf keeps only the words, in the message box.</td>
            <td>Nothing to remove</td>
          </tr>
          <tr>
            <td>Claude API key, if you keep it in the browser</td>
            <td>Memory only, by default. If you choose "Remember on this device", it is encrypted with a browser key that cannot be exported and stored in IndexedDB.</td>
            <td>Settings → Claude → Forget key, or clear all data</td>
          </tr>
          <tr>
            <td>Sign-in session, if you have an account</td>
            <td>A cookie that scripts on the page cannot read, sent only to the Kerf server</td>
            <td>Sign out</td>
          </tr>
          <tr>
            <td>A mark that this browser has signed in to your account before, so failed sign-ins elsewhere can't lock it out</td>
            <td>A cookie that scripts on the page cannot read, kept for a year</td>
            <td>Clear this site's cookies</td>
          </tr>
        </tbody>
      </table>
      <h2>On the Kerf server, only if you sign in</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>How long</th>
            <th>How to remove it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Your email, name, a scrypt hash of your password (never the password itself), whether your email is confirmed, and which terms you accepted</td>
            <td>Until you delete the account. On an invite-only server, a sign-up whose emailed link is never used is removed after 7 days.</td>
            <td>Settings → Account → Delete account</td>
          </tr>
          <tr>
            <td>Projects you add to your account, with thumbnails, up to 300 versions of history each, their chats, and the files they use (imported STEP files, reference photos and PDFs)</td>
            <td>Until you delete them. A small marker that a project was deleted is kept for 90 days so your other devices remove it too. A file no project uses any more is removed after a day.</td>
            <td>Delete the project, or delete the account</td>
          </tr>
          <tr>
            <td>Your Claude API key, if you save it to your account</td>
            <td>Until you remove it. It is encrypted with AES-256-GCM under a key only the server holds, and only its last 4 characters are ever shown back.</td>
            <td>Settings → Claude → Remove, or delete the account</td>
          </tr>
          <tr>
            <td>Signed-in devices: a hash of each session token, the browser name, IP address and when it was last used</td>
            <td>Until you sign out, after 30 days unused, or 90 days at most</td>
            <td>Sign out, or sign a device out in Settings → Account</td>
          </tr>
          <tr>
            <td>Security activity (sign-ins, password and key changes, with IP addresses)</td>
            <td>Your latest 200 events</td>
            <td>Delete the account</td>
          </tr>
          <tr>
            <td>Daily counts of Claude requests and tokens by model, used for the usage chart and any shared allowance. Never the content of your messages.</td>
            <td>About 13 months</td>
            <td>Delete the account</td>
          </tr>
        </tbody>
      </table>
      <p>The server sends you email only to confirm your address or reset your password, through the email provider its operator chose. It does not log the content of requests.</p>
      <h2>What is sent to Anthropic</h2>
      <p>Only when you send a chat message, Kerf sends Anthropic's API (api.anthropic.com): your message, the conversation so far in that project, the current design file, check results, and images of the 3D view that Claude asks for. With the key on your account, the same content goes through the Kerf server, which adds the key, passes it on without storing it, and labels the request with a random-looking ID derived from your account rather than your email. Anthropic processes this under its own commercial terms and privacy policy. Apart from checking a key when you add it, Kerf does not send anything to Anthropic until you chat.</p>
      <h2>Voice input</h2>
      <p>The microphone is off until you tap the mic button or press V. Kerf uses your browser's built-in speech recognition and never records, stores or uploads audio itself.</p>
      <ul>
        <li>
          <b>On your device, when possible.</b> If your browser can recognise speech on the device (for example recent Chrome on Windows, Mac and Linux, after a one-time language download of around 60 MB), Kerf uses that, and your audio does not leave your device.
        </li>
        <li>
          <b>Your browser's online speech service, only if you allow it.</b> Otherwise, and only after you agree, your browser sends your audio to its maker's speech service while the microphone is on, and gets the text back: Google for Chrome, Apple for Safari and every browser on iPhone and iPad, and Microsoft for Edge. That company processes the audio under its own privacy policy, not this one. You can withdraw your permission at any time in Settings → Voice.
        </li>
        <li>The microphone turns off when you pause, after two minutes, or when you switch away from Kerf. While it is on, Kerf shows where your speech is being turned into text.</li>
        <li>The words go to Anthropic only when you send the message, exactly like typed text.</li>
      </ul>
      <p>Kerf's Content Security Policy controls the connections Kerf itself makes. It cannot govern the browser's own speech service, which is why Kerf asks before using it.</p>
      <h2>What is sent elsewhere</h2>
      <p>Nothing else. The 3D kernel, checks and exports run on your device. Fonts and code are bundled with the app. The web server that hosts Kerf sees ordinary web requests for the app's files, as with any website.</p>
      <h2>Security</h2>
      <ul>
        <li>The app sets a strict Content Security Policy that only allows network connections to its own server and to api.anthropic.com.</li>
        <li>Only Kerf's own page may use the microphone, and only for voice input. Your browser asks for your permission the first time.</li>
        <li>AI output is never rendered as HTML, and imported files are size-limited and validated before use.</li>
        <li>On the server, passwords are hashed with scrypt, sign-in attempts are rate-limited, session cookies are HttpOnly, Secure and SameSite=Strict, and requests from other websites are refused.</li>
        <li>Anyone with access to your unlocked computer and browser profile could use a remembered key or a signed-in session. Do not remember the key on a shared computer, and sign out with "remove copies" there.</li>
      </ul>
      <h2>Children</h2>
      <p>Kerf is not directed at children under 13, and an Anthropic API account is required for the AI features.</p>
      <h2>Changes</h2>
      <p>If this notice changes in a way that affects your data, Kerf will tell you before you continue.</p>
    </Doc>
  );
}

function AcceptableUse() {
  return (
    <Doc title="Acceptable use policy">
      <p>Use Kerf to design things responsibly. Do not use Kerf, or its AI features, to:</p>
      <ul>
        <li>design firearms, firearm components or accessories that convert or enhance them, explosives or their components, or any other weapon;</li>
        <li>design anything intended to injure people or animals, damage property, or evade safety systems;</li>
        <li>infringe someone else's intellectual property, such as copying a protected design you have no rights to;</li>
        <li>break the law, or break Anthropic's usage policies when using the AI features;</li>
        <li>try to extract your API key from other users, attack the app, or overload Anthropic's services.</li>
      </ul>
      <p>Claude may refuse requests that conflict with these rules or with Anthropic's policies.</p>
    </Doc>
  );
}

const LICENCES: { name: string; use: string; licence: string; url: string }[] = [
  { name: "Open CASCADE Technology (via replicad-opencascadejs 1.1)", use: "Exact solid modelling kernel, compiled to WebAssembly", licence: "LGPL-2.1 with the OCCT exception", url: "https://dev.opencascade.org/resources/licensing" },
  { name: "replicad 1.1", use: "JavaScript API over OpenCASCADE", licence: "MIT", url: "https://github.com/sgenoud/replicad" },
  { name: "three.js 0.169", use: "3D viewport", licence: "MIT", url: "https://github.com/mrdoob/three.js" },
  { name: "React 18 and React DOM", use: "User interface", licence: "MIT", url: "https://github.com/facebook/react" },
  { name: "CodeMirror 6 and Lezer", use: "Code editor", licence: "MIT", url: "https://github.com/codemirror/dev" },
  { name: "Anthropic TypeScript SDK", use: "Talking to the Claude API", licence: "MIT", url: "https://github.com/anthropics/anthropic-sdk-typescript" },
  { name: "Zustand 5", use: "App state", licence: "MIT", url: "https://github.com/pmndrs/zustand" },
  { name: "Framer Motion 11", use: "Animation", licence: "MIT", url: "https://github.com/motiondivision/motion" },
  { name: "Zod 4", use: "Validating imported files and tool input", licence: "MIT", url: "https://github.com/colinhacks/zod" },
  { name: "IBM Plex Sans and Mono", use: "Typefaces", licence: "SIL Open Font License 1.1", url: "https://github.com/IBM/plex" },
  { name: "Hono 4 and @hono/node-server", use: "Kerf server: web framework", licence: "MIT", url: "https://github.com/honojs/hono" },
  { name: "Nodemailer", use: "Kerf server: account emails", licence: "MIT-0", url: "https://github.com/nodemailer/nodemailer" },
  { name: "SQLite (built into Node.js)", use: "Kerf server: database", licence: "Public domain", url: "https://sqlite.org/copyright.html" },
];

function Licenses() {
  return (
    <Doc title="Open-source licences" draft={false}>
      <p>Kerf is built on these open-source projects. Thank you to their authors.</p>
      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>Used for</th>
            <th>Licence</th>
          </tr>
        </thead>
        <tbody>
          {LICENCES.map((l) => (
            <tr key={l.name}>
              <td>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.name}
                </a>
              </td>
              <td>{l.use}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>
                {l.licence}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>About the OpenCASCADE licence</h2>
      <p>Open CASCADE Technology is distributed under the GNU Lesser General Public License 2.1 with an additional exception. Kerf loads it as a separate, unmodified WebAssembly module, so it can be replaced with another compatible build. Its source code is available from the Open CASCADE project and the replicad-opencascadejs package.</p>
      <p>The full licence texts ship with each package in the app's dependencies.</p>
    </Doc>
  );
}
