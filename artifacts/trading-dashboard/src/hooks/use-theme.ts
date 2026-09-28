import { useState, useEffect } from "react";
import { useLocation } from "wouter";

export function useTheme() {
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return { theme, setTheme };
}
