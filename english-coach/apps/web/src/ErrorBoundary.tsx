import React, { Component, type ReactNode } from "react";

// A view that throws during render (e.g. an unexpected wire shape) must not
// unmount the whole app — React tears down the nearest error boundary. This
// one is a thin, stateless message: the nav above the routes stays alive.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <div role="alert"><strong>Something went wrong.</strong> <p>{this.state.error.message}</p></div>;
    }
    return this.props.children;
  }
}
