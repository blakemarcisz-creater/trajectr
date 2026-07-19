// BLE transports for the R10 protocol layer.
// Native (Android app): @capacitor-community/bluetooth-le
// Browser (desktop/tablet Chrome testing): Web Bluetooth

import { BleClient } from '@capacitor-community/bluetooth-le';
import { UUIDS } from './r10-protocol.js';

const isNative = () => window.Capacitor?.isNativePlatform?.() === true;

export async function connectR10({ onDisconnect, onBattery, onLog }) {
  return isNative()
    ? connectNative({ onDisconnect, onBattery, onLog })
    : connectWeb({ onDisconnect, onBattery, onLog });
}

async function connectNative({ onDisconnect, onBattery, onLog }) {
  await BleClient.initialize({ androidNeverForLocation: true });
  const device = await BleClient.requestDevice({
    optionalServices: [
      UUIDS.BATTERY_SERVICE, UUIDS.DEVICE_INFO_SERVICE,
      UUIDS.DEVICE_INTERFACE_SERVICE, UUIDS.MEASUREMENT_SERVICE,
    ],
  });
  await BleClient.connect(device.deviceId, () => onDisconnect?.());
  onLog?.('ok', `Connected: ${device.name ?? device.deviceId}`);

  try {
    const batt = await BleClient.read(device.deviceId, UUIDS.BATTERY_SERVICE, UUIDS.BATTERY_CHAR);
    onBattery?.(batt.getUint8(0));
    await BleClient.startNotifications(device.deviceId, UUIDS.BATTERY_SERVICE, UUIDS.BATTERY_CHAR,
      v => onBattery?.(v.getUint8(0)));
  } catch (e) { onLog?.('err', 'Battery unavailable: ' + e.message); }

  let notifyCb = null;
  await BleClient.startNotifications(
    device.deviceId, UUIDS.DEVICE_INTERFACE_SERVICE, UUIDS.DEVICE_INTERFACE_NOTIFIER,
    (value) => notifyCb?.(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  );

  return {
    name: device.name ?? 'R10',
    write: (bytes) => BleClient.write(
      device.deviceId, UUIDS.DEVICE_INTERFACE_SERVICE, UUIDS.DEVICE_INTERFACE_WRITER,
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    ),
    onNotify: (cb) => { notifyCb = cb; },
    disconnect: () => BleClient.disconnect(device.deviceId).catch(() => {}),
  };
}

async function connectWeb({ onDisconnect, onBattery, onLog }) {
  if (!navigator.bluetooth) throw new Error('Bluetooth not available in this browser');
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [
      UUIDS.BATTERY_SERVICE, UUIDS.DEVICE_INFO_SERVICE,
      UUIDS.DEVICE_INTERFACE_SERVICE, UUIDS.MEASUREMENT_SERVICE,
    ],
  });
  device.addEventListener('gattserverdisconnected', () => onDisconnect?.());
  const server = await device.gatt.connect();
  onLog?.('ok', `Connected: ${device.name ?? '(unnamed)'}`);

  try {
    const battSvc = await server.getPrimaryService(UUIDS.BATTERY_SERVICE);
    const battCh = await battSvc.getCharacteristic(UUIDS.BATTERY_CHAR);
    const v = await battCh.readValue();
    onBattery?.(v.getUint8(0));
    await battCh.startNotifications();
    battCh.addEventListener('characteristicvaluechanged', e => onBattery?.(e.target.value.getUint8(0)));
  } catch (e) { onLog?.('err', 'Battery unavailable: ' + e.message); }

  const ifaceSvc = await server.getPrimaryService(UUIDS.DEVICE_INTERFACE_SERVICE);
  const notifier = await ifaceSvc.getCharacteristic(UUIDS.DEVICE_INTERFACE_NOTIFIER);
  const writer = await ifaceSvc.getCharacteristic(UUIDS.DEVICE_INTERFACE_WRITER);
  await notifier.startNotifications();

  let notifyCb = null;
  notifier.addEventListener('characteristicvaluechanged', e =>
    notifyCb?.(new Uint8Array(e.target.value.buffer)));

  return {
    name: device.name ?? 'R10',
    write: (bytes) => writer.writeValueWithResponse
      ? writer.writeValueWithResponse(bytes)
      : writer.writeValue(bytes),
    onNotify: (cb) => { notifyCb = cb; },
    disconnect: () => device.gatt.disconnect(),
  };
}
