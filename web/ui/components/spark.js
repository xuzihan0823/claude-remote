import { html } from '../../vendor/preact-htm-standalone.module.js';

export const Spark = ({ cls = '' }) => html`
  <svg class="spark ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
    <line x1="12" y1="12" x2="12.12" y2="2.61" stroke-width="2.1"/>
    <line x1="12" y1="12" x2="15.74" y2="4.05" stroke-width="1.87"/>
    <line x1="12" y1="12" x2="19.08" y2="5.26" stroke-width="2.11"/>
    <line x1="12" y1="12" x2="20.5" y2="9.21" stroke-width="2.12"/>
    <line x1="12" y1="12" x2="20.99" y2="13.22" stroke-width="1.64"/>
    <line x1="12" y1="12" x2="20.58" y2="16.96" stroke-width="1.93"/>
    <line x1="12" y1="12" x2="18" y2="19.28" stroke-width="2.09"/>
    <line x1="12" y1="12" x2="14.53" y2="21.37" stroke-width="1.52"/>
    <line x1="12" y1="12" x2="10.46" y2="20.4" stroke-width="1.63"/>
    <line x1="12" y1="12" x2="6.11" y2="19.54" stroke-width="1.52"/>
    <line x1="12" y1="12" x2="3.33" y2="17.48" stroke-width="1.84"/>
    <line x1="12" y1="12" x2="2.92" y2="12.61" stroke-width="1.81"/>
    <line x1="12" y1="12" x2="3.77" y2="9.83" stroke-width="1.89"/>
    <line x1="12" y1="12" x2="5.43" y2="5.94" stroke-width="1.95"/>
    <line x1="12" y1="12" x2="8.02" y2="3.85" stroke-width="2.02"/>
  </svg>`;
