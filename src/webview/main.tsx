import { render, h } from 'preact';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  render(h(App, {}), root);
}
