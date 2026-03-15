import './styles.css';
import { AppController } from './app/App';

let app: AppController | null = null;
try {
  app = new AppController();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error('Motion Editor initialization failed:', error);

  const appRoot = document.getElementById('app');
  if (appRoot) {
    appRoot.dataset.viewerState = 'error';
  }

  const stateChip = document.getElementById('state-chip');
  if (stateChip) {
    stateChip.textContent = 'Error';
  }

  const statusTitle = document.getElementById('status-title');
  if (statusTitle) {
    statusTitle.textContent = 'Initialization Failed';
  }

  const statusDetail = document.getElementById('status-detail');
  if (statusDetail) {
    statusDetail.textContent = reason;
  }

  const dropHint = document.getElementById('drop-hint');
  if (dropHint) {
    dropHint.textContent =
      'Check browser console for stack trace, then refresh. If issue persists, share the error message.';
  }
}

window.addEventListener('beforeunload', () => {
  app?.dispose();
});
