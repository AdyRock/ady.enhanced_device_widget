/* jslint node: true */

'use strict';

if (process.env.DEBUG === '1')
{
	// eslint-disable-next-line node/no-unsupported-features/node-builtins, global-require
	// require('inspector').open(9229, '0.0.0.0', true);
}

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const DeviceManager = require('./lib/DeviceManager');
const DeviceDispatcher = require('./lib/DeviceStateChangedDispatcher');
const nodemailer = require('./nodemailer');

class MyApp extends Homey.App
{

	/**
	 * onInit is called when the app is initialized.
	 */
	async onInit()
	{
		this.diagLog = '';
		this.logLevel = this.homey.settings.get('logLevel');
		if (this.logLevel === undefined)
		{
			this.logLevel = 0;
			this.homey.settings.set('logLevel', this.logLevel);
		}

		this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
		this.deviceManager = new DeviceManager(this);

		await this.deviceManager.register();

		this.deviceDispather = new DeviceDispatcher(this);

		try
		{
			const widget = this.homey.dashboards.getWidget('enhanced-device');

			widget.registerSettingAutocompleteListener('devices', async (query, settings) =>
			{
				const devices = await this.getHomeyDevices({});
				return devices.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
			});
		}
		catch (e)
		{
			this.updateLog(`\nError ${e.message} when registering widget setting autocomplete listener`);
		}

		const simSettings = {
			devices: {
				name: '84:f7:03:3a:1f:26',
				id: '50a0144e-33fe-46b2-aa3e-62c0b103c5e1',
			},
		};

		this.homey.settings.set('simSettings', simSettings);

		this.homey.on('settings:set', async (settings) =>
		{
			if (settings.key === 'logLevel')
			{
				this.logLevel = settings.value;
			}
		});

		// Create the Flow action set-status card
		this.homey.flow.getActionCard('set-status')
			.registerRunListener(async (args, state) =>
			{
				const { widgetID, title, status, backColour, textColour } = args;
				this.homey.settings.set(widgetID, { title, status, backColour, textColour });
				this.homey.api.realtime('updateStatus', { widgetID, title, status, backColour, textColour });
				return true;
			});

		this.log('MyApp has been initialized');
	}

	async getDeviceImageURI(deviceId)
	{
		if (this.deviceManager)
		{
			try
			{
				const device = await this.getDeviceById(deviceId);
				if (!device)
				{
					// Device not found
					return null;
				}
				let iconURI = device?.iconObj?.url;
				if (device.iconOverride)
				{
					iconURI = `https://my.homey.app/img/devices/${device.iconOverride}.svg`;
				}

				if (this.logLevel > 0)
				{
					this.updateLog(`Device image URL for ${deviceId}:\n${JSON.stringify(device.iconObj, null, 2)}`);
				}

				return iconURI;
			}
			catch (e)
			{
				this.error('Error getting device image', e);
				this.updateLog(`\nError ${e.message} when getting device image ${deviceId}`);
			}
		}

		return null;
	}

	async getHomeyDevices({ type = '', ids = null })
	{
		if (this.deviceManager)
		{
			try
			{
				let devices = {};
				if (this.deviceManager && this.deviceManager.devices)
				{
					devices = this.deviceManager.devices;
				}
				else
				{
					const api = await HomeyAPI.forCurrentHomey(this.homey);
					devices = await api.devices.getDevices();
				}

				// Sort the devices by name
				devices = Object.values(devices).sort((a, b) => a.name.localeCompare(b.name));

				if (type || ids)
				{
					// Filter the object on type or id
					const filteredDevices = [];
					// Turn the devices object into an array, filter on type or id and turn it back into an object
					const deviceArray = Object.values(devices);
					for (const device of deviceArray)
					{
						device.IconPath = device.iconObj?.url && this.cloudUrl ? `${this.cloudUrl}${device.iconObj.url}` : null;

						const capabilities = await this.deviceManager.getCapabilities(device);
						const capabilitiesArray = Object.values(capabilities);
						for (const capability of capabilitiesArray)
						{
							if ((type && capability.type === type) || (ids && this.id.findIndex((id) => capability.id === id) >= 0))
							{
								filteredDevices.push(device);
								break;
							}
						}
					}

					// return the filtered devices as an object
					devices = {};
					for (const device of filteredDevices)
					{
						devices[device.id] = device;
					}
				}

				return devices;
			}
			catch (e)
			{
				this.error('Error getting devices', e);
				this.updateLog(`\nError ${e.message} when getting devices`);
			}
		}
		return [];
	}

	async getCapabilities(deviceId, disabledCapabilities)
	{
		if (this.deviceManager)
		{
			const capabilities = await this.deviceManager.getCapabilities(deviceId);
			if (disabledCapabilities)
			{
				// For each capability, register the capability with registerDeviceCapability provide it's not in the disabledCapabilities
				const capabilitiesArray = Object.values(capabilities);
				for (const capability of capabilitiesArray)
				{
					try
					{
						if (!disabledCapabilities[capability.id])
						{
							await this.deviceDispather.registerDeviceCapability(deviceId, capability.id);
						}
					}
					catch (e)
					{
						this.error('Error registering capability', e);
					}
				}
			}
			if (this.logLevel > 0)
			{
				this.updateLog(`\nCapabilities for ${deviceId}:\n${JSON.stringify(capabilities, null, 2)}`);
			}

			return capabilities;
		}
		return [];
	}

	async setCapability(deviceId, capabilityId, value)
	{
		if (this.deviceManager)
		{
			try
			{
				const device = await this.getDeviceById(deviceId);
				if (!device)
				{
					// Device not found
					this.error(`Device not found: ${deviceId}`);
					this.updateLog(`\nDevice not found: ${deviceId}`);
					return;
				}

				// Find the capability that is defined in the configuration
				const capability = await this.getCapabilityById(device, capabilityId);
				if (!capability)
				{
					// Capability not found
					this.error(`Capability not found: ${deviceId} - ${capabilityId}`);
					this.updateLog(`\nCapability not found: ${deviceId} - ${capabilityId}`);
					return;
				}

				await device.setCapabilityValue(capabilityId, value);
				if (this.logLevel > 0)
				{
					this.updateLog(`\nSet ${deviceId}: ${capabilityId} to ${value}`);
				}
			}
			catch (e)
			{
				this.error('Error setting capability', e);
				this.updateLog(`\nError ${e.message} when setting ${deviceId}: ${capabilityId} to ${value}`);
			}
		}
	}

	async getDeviceById(id)
	{
		if (this.deviceManager)
		{
			try
			{
				if (this.deviceManager.devices)
				{
					const device = await this.deviceManager.getDeviceById(id);
					if (this.logLevel > 1)
					{
						this.updateLog(`Device:\n${JSON.stringify(device, null, 2)}`);
					}

					return device;
				}
			}
			catch (e)
			{
				this.error('Error getting device', e);
				this.updateLog(`\nError ${e.message} when getting device ${id}`);
			}
		}
		return undefined;
	}

	async getCapabilityById(device, capabilityId)
	{
		if (this.deviceManager && device)
		{
			try
			{
				return this.deviceManager.getCapability(device, capabilityId);
			}
			catch (e)
			{
				this.error('Error getting capability', e);
				this.updateLog(`Error ${e.message} when getting capability ${device.id}: ${capabilityId}`);
			}
		}
		return undefined;
	}

	updateLog(Message)
	{
		this.diagLog += `\n${Message}`;
		if (this.diagLog.length > 60000)
		{
			this.diagLog = this.diagLog.substr(this.diagLog.length - 60000);
		}

		this.homey.api.realtime('logupdated', { log: this.diagLog });
	}

	// Send the log to the developer (not applicable to Homey cloud)
	async sendLog()
	{
		let tries = 5;
		let error = null;
		while (tries-- > 0)
		{
			try
			{
				// create reusable transporter object using the default SMTP transport
				const transporter = nodemailer.createTransport(
					{
						host: Homey.env.MAIL_HOST, // Homey.env.MAIL_HOST,
						port: 465,
						ignoreTLS: false,
						secure: true, // true for 465, false for other ports
						auth:
						{
							user: Homey.env.MAIL_USER, // generated ethereal user
							pass: Homey.env.MAIL_SECRET, // generated ethereal password
						},
						tls:
						{
							// do not fail on invalid certs
							rejectUnauthorized: false,
						},
					},
				);

				// send mail with defined transport object
				const info = await transporter.sendMail(
					{
						from: `"Homey User" <${Homey.env.MAIL_USER}>`, // sender address
						to: Homey.env.MAIL_RECIPIENT, // list of receivers
						subject: `Enhanced Device log (${Homey.manifest.version})`, // Subject line
						text: `${this.diagLog}`, // plain text body
					},
				);

				this.updateLog(`Message sent: ${info.messageId}`);
				// Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

				// Preview only available when sending through an Ethereal account
				this.log('Preview URL: ', nodemailer.getTestMessageUrl(info));
				return this.homey.__('settings.logSent');
			}
			catch (err)
			{
				this.updateLog(`Send log error: ${err.message}`, 0);
				error = err;
			}
		}

		throw new Error(this.homey.__('settings.logSendFailed') + error.message);
	}

}
module.exports = MyApp;
