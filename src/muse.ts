import { Observable } from 'rxjs/Observable';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import 'rxjs/add/observable/merge';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/first';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/toPromise';

import { EEGReading, TelemetryData, AccelerometerData, GyroscopeData, XYZ, MuseControlResponse, MuseDeviceInfo } from './lib/muse-interfaces';
import { parseControl, decodeEEGSamples, parseTelemetry, parseAccelerometer, parseGyroscope } from './lib/muse-parse';
import { encodeCommand, decodeResponse, observableCharacteristic } from './lib/muse-utils';

export { zipSamples, EEGSample } from './lib/zip-samples';
export { EEGReading, TelemetryData, AccelerometerData, GyroscopeData, XYZ, MuseControlResponse };

export const MUSE_SERVICE = 0xfe8d;
const CONTROL_CHARACTERISTIC = '273e0001-4c4d-454d-96be-f03bac821358';
const TELEMETRY_CHARACTERISTIC = '273e000b-4c4d-454d-96be-f03bac821358';
const GYROSCOPE_CHARACTERISTIC = '273e0009-4c4d-454d-96be-f03bac821358';
const ACCELEROMETER_CHARACTERISTIC = '273e000a-4c4d-454d-96be-f03bac821358';
const EEG_CHARACTERISTICS = [
    '273e0003-4c4d-454d-96be-f03bac821358',
    '273e0004-4c4d-454d-96be-f03bac821358',
    '273e0005-4c4d-454d-96be-f03bac821358',
    '273e0006-4c4d-454d-96be-f03bac821358',
    '273e0007-4c4d-454d-96be-f03bac821358'
];
export const EEG_FREQUENCY = 256;

// These names match the characteristics defined in EEG_CHARACTERISTICS above
export const channelNames = [
    'TP9',
    'AF7',
    'AF8',
    'TP10',
    'AUX'
];

export class MuseClient {
    private gatt: BluetoothRemoteGATTServer | null = null;
    private controlChar: BluetoothRemoteGATTCharacteristic;
    private eegCharacteristics: BluetoothRemoteGATTCharacteristic[];

    public enableAux = false;
    public deviceName: string | null = '';
    public connectionStatus = new BehaviorSubject<boolean>(false);
    public rawControlData: Observable<string>;
    public controlResponses: Observable<MuseControlResponse>;
    public telemetryData: Observable<TelemetryData>;
    public gyroscopeData: Observable<GyroscopeData>;
    public accelerometerData: Observable<AccelerometerData>;
    public eegReadings: Observable<EEGReading>;

    private lastIndex: number | null = null;
    private lastTimestamp: number | null = null;

    async connect(gatt?: BluetoothRemoteGATTServer) {
        if (gatt) {
            this.gatt = gatt;
        } else {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [MUSE_SERVICE] }]
            });
            this.gatt = await device.gatt!.connect();
        }
        this.deviceName = this.gatt.device.name || null;

        const service = await this.gatt.getPrimaryService(MUSE_SERVICE);
        Observable.fromEvent<void>(this.gatt.device, 'gattserverdisconnected').first().subscribe(() => {
            this.gatt = null;
            this.connectionStatus.next(false);
        });

        // Control
        this.controlChar = await service.getCharacteristic(CONTROL_CHARACTERISTIC);
        this.rawControlData = (await observableCharacteristic(this.controlChar))
            .map(data => decodeResponse(new Uint8Array(data.buffer)))
            .share();
        this.controlResponses = parseControl(this.rawControlData);

        // Battery
        const telemetryCharacteristic = await service.getCharacteristic(TELEMETRY_CHARACTERISTIC);
        this.telemetryData = (await observableCharacteristic(telemetryCharacteristic))
            .map(parseTelemetry);

        // Gyroscope
        const gyroscopeCharacteristic = await service.getCharacteristic(GYROSCOPE_CHARACTERISTIC);
        this.gyroscopeData = (await observableCharacteristic(gyroscopeCharacteristic))
            .map(parseGyroscope);

        // Accelerometer
        const accelerometerCharacteristic = await service.getCharacteristic(ACCELEROMETER_CHARACTERISTIC);
        this.accelerometerData = (await observableCharacteristic(accelerometerCharacteristic))
            .map(parseAccelerometer);

        // EEG
        this.eegCharacteristics = [];
        const eegObservables = [];
        const channelCount = this.enableAux ? EEG_CHARACTERISTICS.length : 4;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
            let characteristicId = EEG_CHARACTERISTICS[channelIndex];
            const eegChar = await service.getCharacteristic(characteristicId);
            eegObservables.push(
                (await observableCharacteristic(eegChar)).map(data => {
                    const eventIndex = data.getUint16(0);
                    return {
                        index: eventIndex,
                        electrode: channelIndex,
                        timestamp: this.getTimestamp(eventIndex),
                        samples: decodeEEGSamples(new Uint8Array(data.buffer).subarray(2))
                    };
                }));
            this.eegCharacteristics.push(eegChar);
        }
        this.eegReadings = Observable.merge(...eegObservables);
        this.connectionStatus.next(true);
    }

    async sendCommand(cmd: string) {
        await this.controlChar.writeValue((encodeCommand(cmd)));
    }

    async start() {
        // Subscribe to EEG characteristics
        await this.pause();
        // Select preset number 20
        await this.controlChar.writeValue(encodeCommand('p20'));
        await this.controlChar.writeValue(encodeCommand('s'));
        await this.resume();
    }

    async pause() {
        await this.sendCommand('h');
    }

    async resume() {
        await this.sendCommand('d');
    }

    async deviceInfo() {
        const resultListener = this.controlResponses.filter(r => !!r.fw).take(1).toPromise();
        await this.sendCommand('v1');
        return resultListener as Promise<MuseDeviceInfo>;
    }

    disconnect() {
        if (this.gatt) {
            this.lastIndex = null;
            this.lastTimestamp = null;
            this.gatt.disconnect();
            this.connectionStatus.next(false);
        }
    }

    private getTimestamp(eventIndex: number) {
        const SAMPLES_PER_READING = 12;
        const READING_DELTA = 1000 * (1.0 / EEG_FREQUENCY) * SAMPLES_PER_READING;
        if (this.lastIndex === null || this.lastTimestamp === null) {
            this.lastIndex = eventIndex;
            this.lastTimestamp = new Date().getTime() - READING_DELTA;
        }

        // Handle wrap around
        while ((this.lastIndex - eventIndex) > 0x1000) {
            eventIndex += 0x10000;
        }

        if (eventIndex === this.lastIndex) {
            return this.lastTimestamp;
        }
        if (eventIndex > this.lastIndex) {
            this.lastTimestamp += READING_DELTA * (eventIndex - this.lastIndex);
            this.lastIndex = eventIndex;
            return this.lastTimestamp;
        } else {
            return this.lastTimestamp - READING_DELTA * (this.lastIndex - eventIndex);
        }
    }
}
