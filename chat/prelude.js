import { ORG_API_BASE } from './config.js';

// Count page views through the same environment-selected oa-org as the rest of
// the client. Keeping this inside the bundled prelude prevents an unbundled
// config import from falling back to production in staging builds.
fetch(`${ORG_API_BASE}/chat/v1/analytics/pageview`, { method: 'POST' }).catch(() => {});

// Pre-render the empty state before app bootstrap for a fast first paint.
(async () => {
    try {
        const container = document.getElementById('messages-container');
        const hasSavedSession = sessionStorage.getItem('oa-current-session');
        if (container && container.childElementCount === 0 && !hasSavedSession) {
            const { buildEmptyState } = await import('./components/MessageTemplates.js');
            container.innerHTML = buildEmptyState();
        }
    } catch (error) {
        console.warn('Prerender failed:', error);
    }
})();
