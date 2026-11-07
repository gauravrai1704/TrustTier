// Keeps one page's error from blanking the whole app: shows what went wrong
// and a way out (reload, or reset the in-browser simulation data).
import { Component } from "react";
import Icon from "./Icon";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  resetSimulation = () => {
    try {
      localStorage.removeItem("trusttier.sim.v1");
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card card-pad stack" role="alert">
        <div className="row"><Icon name="alert" /><h2 style={{ fontSize: 16 }}>This page hit an error</h2></div>
        <div className="small ink2">The rest of the app still works. If you used the simulation with an older version of this site,
          resetting its saved data usually fixes this.</div>
        <code className="small muted" style={{ wordBreak: "break-word" }}>{String(this.state.error?.message || this.state.error)}</code>
        <div className="row-wrap">
          <button className="btn" onClick={() => window.location.reload()}><Icon name="refresh" />Reload</button>
          <button className="btn" onClick={this.resetSimulation}><Icon name="reset" />Reset simulation data</button>
          <a className="btn btn-ghost" href="#/overview">Back to overview</a>
        </div>
      </section>
    );
  }
}
