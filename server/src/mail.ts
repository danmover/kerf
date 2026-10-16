// Account email (verification and password reset). With SMTP_URL set, mail
// goes through any SMTP provider; in development it is printed to the console.

import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** false when the server cannot send email at all */
  readonly available: boolean;
  send(m: Mail): Promise<void>;
}

export function createMailer(cfg: Config, log: (s: string) => void = console.log): Mailer {
  if (cfg.smtpUrl) {
    const transport = nodemailer.createTransport(cfg.smtpUrl);
    return {
      available: true,
      async send(m) {
        await transport.sendMail({ from: cfg.mailFrom, to: m.to, subject: m.subject, text: m.text });
      },
    };
  }
  if (!cfg.production) {
    return {
      available: true,
      async send(m) {
        log(`\n--- email (development: not sent) ---\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n--- end email ---\n`);
      },
    };
  }
  return {
    available: false,
    async send() {
      throw new Error("Email is not configured on this server (set SMTP_URL).");
    },
  };
}

/** A memory mailer for tests. */
export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    available: true,
    sent,
    async send(m) {
      sent.push(m);
    },
  };
}

export const verifyEmail = (origin: string, token: string): Omit<Mail, "to"> => ({
  subject: "Confirm your email for Kerf",
  text: `Confirm this address for your Kerf account by opening this link:\n\n${origin}/#verify=${token}\n\nThe link works for 24 hours. If you did not create a Kerf account, ignore this email.`,
});

export const resetEmail = (origin: string, token: string): Omit<Mail, "to"> => ({
  subject: "Reset your Kerf password",
  text: `Someone asked to reset the password for your Kerf account. To choose a new password, open this link:\n\n${origin}/#reset=${token}\n\nThe link works for one hour and only once. If you did not ask for this, ignore this email; your password has not changed.`,
});

export const signupEmail = (origin: string, token: string): Omit<Mail, "to"> => ({
  subject: "Finish creating your Kerf account",
  text: `To finish creating your Kerf account, open this link and choose a password:\n\n${origin}/#signup=${token}\n\nThe link works for 24 hours and only once. If you did not ask for a Kerf account, ignore this email; nothing has been created.`,
});
