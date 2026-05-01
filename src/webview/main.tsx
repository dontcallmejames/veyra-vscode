import { render, h } from 'preact';
import { App } from './App.js';
import css from './styles.css';

// esbuild's text loader gives us the CSS as a string. Inject it into <head>.
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

const root = document.getElementById('root');
if (root) {
  render(h(App, {}), root);
}
