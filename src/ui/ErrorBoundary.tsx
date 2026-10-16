// Keeps one failing panel from taking down the whole app.

import { Component, type ReactNode } from "react";
import { Icon } from "./icons";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode; label: string; full?: boolean }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[kerf] ${this.props.label} crashed`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", padding: 20, background: "var(--bg-1)" }}>
        <div className="card" style={{ padding: 20, maxWidth: 420, textAlign: "center" }}>
          <div style={{ color: "var(--fail)", marginBottom: 8 }}>
            <Icon.Alert size={22} />
          </div>
          <div style={{ fontWeight: 600 }}>The {this.props.label.toLowerCase()} hit a problem</div>
          <div className="mono dim" style={{ fontSize: 11.5, marginTop: 6, wordBreak: "break-word" }}>
            {this.state.error.message}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Your design is saved. Reloading this panel usually fixes it.
          </div>
          <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Reload panel
            </button>
            {this.props.full && (
              <button className="btn primary" onClick={() => location.reload()}>
                Reload Kerf
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
