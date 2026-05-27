import { mount } from "svelte";
import App from "$lib/components/App.svelte";
import "./app.css";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");

mount(App, { target: root });
