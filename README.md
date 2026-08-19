# IP Switcher — Instrucciones para generar el .exe

## Requisitos previos

Instala estos programas si no los tienes:

1. **Node.js** (versión 18 o superior) → https://nodejs.org
2. **Git** (opcional) → https://git-scm.com

---

## Pasos para compilar el .exe

### 1. Abre una terminal (CMD o PowerShell) en esta carpeta

```
cd ruta\a\ip-switcher
```

### 2. Instala las dependencias

```
npm install
```

Esto descarga todos los paquetes necesarios (~5 minutos la primera vez).

### 3. Compila el .exe

**Instalador + Portable:**
```
npm run dist
```

**Solo portable (sin instalador):**
```
npm run dist-portable
```

### 4. Encuentra tu .exe

Los archivos se generan en la carpeta `dist/`:
- `IP Switcher Setup 1.0.0.exe` → instalador con acceso directo
- `IP Switcher 1.0.0.exe` → versión portable (un solo archivo)

---

## Probar sin compilar (modo desarrollo)

Si solo quieres probar la app sin compilar:

```
npm run electron-dev
```

Esto abre la ventana de la app directamente.

---

## Estructura del proyecto

```
ip-switcher/
├── electron/
│   ├── main.js       → proceso principal de Electron
│   └── preload.js    → puente seguro entre Electron y React
├── src/
│   ├── App.js        → interfaz de la aplicación
│   └── index.js      → entrada de React
├── public/
│   └── index.html    → HTML base
└── package.json      → configuración y scripts
```

## Dónde se guardan los datos

Los perfiles se guardan automáticamente en:
- **Windows:** `%APPDATA%\ip-switcher\ip-profiles.json`
- **macOS:** `~/Library/Application Support/ip-switcher/ip-profiles.json`

---

## Compilar para Mac o Linux

```
npm run build && electron-builder --mac
npm run build && electron-builder --linux
```
