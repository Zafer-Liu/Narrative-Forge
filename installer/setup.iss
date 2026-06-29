#define MyAppName "Narrative Forge"
#define MyAppChineseName "叙事锻造工坊"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Narrative Forge Contributors"
#define MyAppExeName "start.bat"

[Setup]
AppId={{A1E1DD42-D060-4EC8-86FC-2491E6244419}
AppName={#MyAppName} ({#MyAppChineseName})
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Narrative Forge
DefaultGroupName=Narrative Forge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=NarrativeForge-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
SetupIconFile=logo.ico
UninstallDisplayName={#MyAppName} ({#MyAppChineseName})
UninstallDisplayIcon={app}\logo.ico
VersionInfoVersion={#MyAppVersion}
VersionInfoDescription=Narrative Forge Installer
VersionInfoProductName=Narrative Forge
VersionInfoCompany={#MyAppPublisher}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Files]
Source: "..\app.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\backend\*"; DestDir: "{app}\backend"; Excludes: "test_server.py,__pycache__\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\start.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README_EN.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\development.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\static\*"; DestDir: "{app}\static"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\player\*"; DestDir: "{app}\player"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\Images\logo.png"; DestDir: "{app}\Images"; Flags: ignoreversion
Source: "logo.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\projects"

[Icons]
Name: "{group}\Narrative Forge"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\logo.ico"
Name: "{group}\卸载 Narrative Forge"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Narrative Forge"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\logo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 Narrative Forge"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.venv"

[Code]
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
  PythonFound: Boolean;
begin
  PythonFound := Exec(
    ExpandConstant('{cmd}'),
    '/C "where py >nul 2>&1 || where python >nul 2>&1"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode
  ) and (ResultCode = 0);

  if not PythonFound then
  begin
    MsgBox(
      '未检测到 Python。Narrative Forge 需要 Python 3.10 或更高版本。' + #13#10 + #13#10 +
      '安装程序可以继续，但首次启动前请从 python.org 安装 Python，并启用 Add Python to PATH。',
      mbInformation, MB_OK
    );
  end;

  Result := True;
end;
