import {
  DeployAddress, DeployBalance,
  DeployConfigModel, DeployContractInitScript,
  DeployContractModel,
  DeployContractRawModel,
  DeploySeedPhrase,
} from './deployer.model';
import { libs, auth, transfer, setScript, broadcast, invokeScript } from '@waves/waves-transactions';
import { create } from '@waves/node-api-js';
import {TLong} from '@waves/node-api-js/es/interface';

export class Deployer {
  private readonly node: string = 'https://nodes.wavesnodes.com';
  private readonly chainId: 'W' | 'T' = 'W';
  private readonly network: ReturnType<typeof create>;

  constructor(node, chainId) {
    this.chainId = chainId;
    this.node = node;
    this.network = create(this.node);
  }

  public async process(config: DeployConfigModel) {

    if (!config.contracts || !config.contracts.length) {
      console.error('Contracts are not passed to the script')
    }

    const contracts = await Promise.all(
      // Get address for all contracts
      config.contracts.map(async (contract: DeployContractRawModel) => {
        const isNew = !contract.seed;
        const seed = contract.seed || libs.crypto.randomSeed(15);

        return {
          ...contract,
          address: await this.getAddress(seed),
          seed: seed,
          balance: 0,
          requestBalance: contract.requestBalance || 10000000,
          isNew,
          init: contract.init || null
        } as DeployContractModel
      })
    )
    .then(async (constracts: DeployContractModel[]) => {
      // Get balances
      return Promise.all(constracts
      .filter(contract => !!contract.address)
      .map(async (contract) => {
        return {
          ...contract,
          balance: await this.getBalance(contract.address, config.deposit, contract.requestBalance, contract.isNew),
          script: await this.convertScript(contract.script)
        }
      }))
    })
    .then(async (constracts: DeployContractModel[]) => {
      // Get balances
      return Promise.all(constracts
      // .filter(contract => contract.balance >= contract.requestBalance)
      .map(async (contract) => {
        return {
          ...contract,
          status: await this.deployContract(contract),
          script: '...'
        }
      }))
    })
    .then(async (constracts: DeployContractModel[]) => {
      // Get balances
      return Promise.all(constracts
          // .filter(contract => contract.balance >= contract.requestBalance)
          .map(async (contract) => {
            return {
              ...contract,
              inited: contract.init ? await this.initScripts(contract.address, contract.seed, contract.init) : false,
            }
          }))
    })
    .catch((error) => {
      console.log('Error on flow: ', error.message);
    })

    console.log('Contracts', contracts);
  }

  private async faucet (address: DeployAddress, depositSeed: DeploySeedPhrase) {

  }

  private async getAddress (seed: DeploySeedPhrase) {
    return auth({
      data: '',
      host: this.node
    }, seed, this.chainId)?.address || null
  }

  private async getBalance (address: DeployAddress | undefined, deposit: DeploySeedPhrase, request: DeployBalance, isNew: boolean) {
    let balance: TLong = 0;

    try {
      balance = !address ? 0 : ((await this.network.addresses.fetchBalance(address))?.balance || 0);
    } catch (error) {
      console.log('Error after we get a balance ', error.message);
    }

    if (balance < request) {
      try {
        const tx = transfer({
              recipient: address!,
              amount: (BigInt(request) - BigInt(balance.toString())).toString(),
              fee: isNew ? 500000 : 900000
            }, deposit
        )

        const waitingTx = await broadcast({
          ...tx
        }, this.node)
        .then(async (data) => {
          await this.checkTx(data.id);
        })

        balance = request;
      } catch (error) {
        console.log('Error after trying to replenish the purses of future contracts ', error.message);
      }
    }

    return balance;
  }

  private async convertScript (script: string) {
    const scr = Buffer.from(script, 'base64')

    try {
      return (await this.network.utils.fetchCompileCode(scr.toString('utf8')))?.script
    } catch (error) {
      console.log('Couldn\'t transform the script into a compatible format. ', error.message)
    }

    return ''
  }

  private async deployContract (contract: DeployContractModel) {
    try {
      const script = setScript({
        fee: 1900000,
        version: 2,
        script: contract.script,
        chainId: this.chainId
      }, contract.seed)

      await broadcast({
        ...script
      }, this.node)
      .then(async (data) => {
        await this.checkTx(data.id)
      })

      return 'success';
    } catch (error) {
      console.error('The process ended with an error', error.message);
    }

    return 'error';
  }

  private async checkTx(id) {
    return new Promise((resolve) => {

      setTimeout(async() => {
        try {
          await this.network.transactions.fetchUnconfirmedInfo(id);
          resolve(this.checkTx(id))
        } catch (error) {
          resolve(true)
        }
      }, 1000)
    })
  }

  private async initScripts(address, seed, scripts: DeployContractInitScript) {
    return scripts ? await Promise.all(Object.keys(scripts).map(async(functionName) => {
      try {
        const tx = invokeScript({
          dApp: address,
          call: {
            function: functionName,
            // @ts-ignore
            args: scripts[functionName]
          },
          fee: 900000,
          chainId: this.chainId
        }, seed)

        console.log('TX', tx);

        await broadcast(tx, this.node)
        .then(async (data) => {
          await this.checkTx(data.id)
        })

        return true
      } catch (error) {
        console.log('Contract initialization failed ', error.message)
      }
    })) : false;
  }
}
