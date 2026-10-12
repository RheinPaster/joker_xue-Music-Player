@echo off
chcp 65001 >nul
rem 切换到脚本所在目录（无论从哪里双击都能定位到项目）
cd /d "%~dp0"

rem 首次使用：如果没有 Electron 本体，自动安装（走国内镜像）
if not exist "node_modules\electron\dist\electron.exe" (
    echo [提示] 首次运行需要安装 Electron，请稍候...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call npm install
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [错误] Electron 安装失败，请检查网络后重试。
    pause
    exit /b 1
)

echo 正在启动薛之谦音乐播放器...
start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0
