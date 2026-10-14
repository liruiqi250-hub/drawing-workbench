'use strict';
const retry = document.getElementById('retry');
const quit = document.getElementById('quit');
async function refresh() {
  try {
    const state = await window.drawingStartup.state();
    if (!state) throw new Error();
    document.getElementById('message').textContent = state.message;
    document.querySelector('.status').classList.toggle('error', state.error);
    document.getElementById('hint').textContent = state.error ? '请按提示检查后重试。退出程序会先正常结束可确认身份的本地后台。' : '首次启动可能需要片刻，请保持窗口打开。';
    retry.disabled = state.busy;
    retry.textContent = state.busy ? '正在启动…' : '重试启动';
  } catch {
    document.getElementById('message').textContent = '桌面连接已中断，请关闭窗口后重新打开软件。';
    retry.disabled = true;
  }
}
retry.addEventListener('click', async () => { retry.disabled = true; await window.drawingStartup.retry(); await refresh(); });
quit.addEventListener('click', () => { void window.drawingStartup.quit(); });
void refresh();
setInterval(refresh, 500);
