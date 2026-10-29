// Hash routing (works on static hosting such as GitHub Pages).
import { useEffect, useState } from "react";

function current() {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [page = "overview", ...rest] = h.split("/");
  return { page: page || "overview", params: rest };
}

export function useRoute() {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const fn = () => {
      setRoute(current());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return route;
}

export function go(path) {
  window.location.hash = `#/${path}`;
}
