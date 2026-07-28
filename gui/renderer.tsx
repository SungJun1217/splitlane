import React from "react";
import { createRoot } from "react-dom/client";
import { Mirror, STYLE } from "./mirror-view.tsx";

// Mounting lives apart from the view so the view can be rendered in a test
// without a DOM. This file is the only one that touches `document`.
const style = document.createElement("style");
style.textContent = STYLE;
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Mirror />);
