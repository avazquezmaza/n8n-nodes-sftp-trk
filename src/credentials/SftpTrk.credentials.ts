import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class SftpTrk implements ICredentialType {
  name = 'sftpTrk';

  displayName = 'SFTP TRK';

  documentationUrl = 'https://github.com/avazquezmaza/.gin8n-nodes-sftp-trk';

  properties: INodeProperties[] = [
    {
      displayName: 'Authentication Method',
      name: 'authMethod',
      type: 'options',
      default: 'password',
      options: [
        { name: 'Password', value: 'password' },
        { name: 'Private Key', value: 'key' },
      ],
    },
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
    },
    {
      displayName: 'Port',
      name: 'port',
      type: 'number',
      default: 22,
    },
    {
      displayName: 'Username',
      name: 'username',
      type: 'string',
      default: '',
      required: true,
    },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      displayOptions: {
        show: {
          authMethod: ['password'],
        },
      },
    },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      typeOptions: {
        rows: 8,
      },
      default: '',
      displayOptions: {
        show: {
          authMethod: ['key'],
        },
      },
    },
    {
      displayName: 'Passphrase',
      name: 'passphrase',
      type: 'string',
      typeOptions: {
        password: true,
      },
      default: '',
      displayOptions: {
        show: {
          authMethod: ['key'],
        },
      },
    },
  ];
}
