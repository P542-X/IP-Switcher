# IP Switcher

IP Switcher is a Windows network utility for managing IP addresses and network configurations.

### Features

* IP Scanner with device identification (PLC, HMI, switch, printer, NAS…)
* IP Connection History
* IP Profile Configuration
* Network IP Monitoring
* Open Port Configuration for each profile

### Download

The latest Windows version is available in the **Releases** section:

**[Download IP Switcher v1.0.1](https://github.com/P542-X/IP-Switcher/releases/latest)**

Download `IP.Switcher.Setup.1.0.1.exe` to install IP Switcher on Windows.

### Latest Version

**Version:** 1.0.1
**Platform:** Windows

### Building from source

```
npm install
npm run build      # React bundle into build/
npm run electron   # run the app
npm run dist       # Windows installer + portable into dist/
```

`npm run selftest` runs the network logic against the current machine
(adapters, IP reading, ARP neighbours, port probing, SNMP, validators).
It changes nothing: it never reaches netsh and never prompts for UAC.
