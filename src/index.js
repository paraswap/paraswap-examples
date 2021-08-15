require("dotenv").config();

const {ParaSwap} = require("paraswap");
const BN = require("bignumber.js");
const Web3 = require("web3");
const HDWalletProvider = require("truffle-hdwallet-provider");

const ERC20_ABI = require('../abi/erc20.json');
const AUGUSTUS_ABI = require('../abi/augustus-v4.json');

const PROVIDER_URL = process.env.PROVIDER_URL;
const TEST_ADDRESS = process.env.TEST_ADDRESS;
const TEST_PKEY = process.env.TEST_PKEY;
const referrer = "chucknorris";
const SLIPPAGE = 1;//1%

const GAS_PRICE = (70 * 10 ** 9).toFixed(); //Use an EIP 1559 friendly way to retrieve gas price

const MAX_UINT = new BN(2).pow(256).minus(1);

const networks = {
  MAINNET: 1,
  POLYGON: 137
}

const EXPLORER = {
  [networks.MAINNET]: "https://etherscan.io",
  [networks.POLYGON]: "https://polygonscan.com"
}

//TODO: make you use the right versions https://developers.paraswap.network/smartcontracts
const AUGUSTUS = {
  [networks.MAINNET]: {
    address: '0x1bD435F3C054b6e901B7b108a0ab7617C808677b',
    spender: '0xb70Bc06D2c9Bf03b3373799606dc7d39346c06B3'//from augustus.getTokenTransferProxy()
  },
  [networks.POLYGON]: {
    address: '0x90249ed4d69D70E709fFCd8beE2c5A566f65dADE',
    spender: '0xCD52384e2A96F6E91e4e420de2F9a8C0f1FFB449'//from augustus.getTokenTransferProxy()
  }
}

const tokens = {
  [networks.MAINNET]: [
    {
      "decimals": 18,
      "symbol": "ETH",
      "address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
    },
    {
      "decimals": 6,
      "symbol": "USDC",
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    },
    {
      "decimals": 18,
      "symbol": "DAI",
      "address": "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    }
  ],
  [networks.POLYGON]: [
    {
      "decimals": 18,
      "symbol": "MATIC",
      "address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
    },
    {
      "decimals": 8,
      "symbol": "WBTC",
      "address": "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
    },
    {
      "decimals": 6,
      "symbol": "USDC",
      "address": "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
    }
  ]
}

function t(symbol, network) {
  network = network || networks.MAINNET;

  return tokens[network].find(t => t.symbol === symbol);
}

class ParaSwapper {
  constructor(network) {
    this.web3Provider = new Web3(PROVIDER_URL);

    this.network = network;

    this.paraSwap = new ParaSwap(network);
  }

  async balanceOf(tokenAddress) {
    if (tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      const balance = await this.web3Provider.eth.getBalance(TEST_ADDRESS);
      return new BN(balance);
    }

    const contract = new this.web3Provider.eth.Contract(ERC20_ABI, tokenAddress);

    const balance = await contract.methods.balanceOf(TEST_ADDRESS).call();

    return new BN(balance);
  }

  async allowance(tokenAddress) {
    const contract = new this.web3Provider.eth.Contract(ERC20_ABI, tokenAddress);

    const _allowance = await contract.methods.allowance(TEST_ADDRESS, AUGUSTUS[this.network].spender).call();

    return new BN(_allowance);
  }

  async approve(tokenAddress, amount) {
    const contract = new this.web3Provider.eth.Contract(ERC20_ABI, tokenAddress);

    const data = contract.methods.approve(AUGUSTUS[this.network].spender, amount);

    const gas = await data.estimateGas({from: TEST_ADDRESS, value: '0'});

    const txObject = {
      from: TEST_ADDRESS,
      to: tokenAddress,
      data: data.encodeABI(),
      chainId: this.network,
      value: '0',
      gasPrice: GAS_PRICE,//TODO: make it dynamic
      gas,
    };

    return this.submitTx(txObject);
  }

  async submitTx(txObject) {
    const provider = new Web3(new HDWalletProvider(TEST_PKEY, PROVIDER_URL));

    return provider.eth.sendTransaction(txObject, async (err, transactionHash) => {
      if (err) {
        return console.error('Tx_Error', txObject.from, err);
      }
      console.log("transactionHash...", transactionHash, `${EXPLORER[this.network]}/tx/${transactionHash}`);
    });
  }

  async getRate(from, to, amount) {
    return this.paraSwap.getRate(from.address, to.address, amount, 'SELL', {referrer}, from.decimals, to.decimals);
  }

  async buildSwap(from, to, srcAmount, minAmount, priceRoute) {
    return this.paraSwap.buildTx(from.address, to.address, srcAmount, minAmount, priceRoute, TEST_ADDRESS, referrer);
  }
}

async function swap(_srcAmount, from, to, network) {
  try {
    const srcAmount = new BN(_srcAmount).times(10 ** from.decimals).toFixed(0);

    const ps = new ParaSwapper(network);

    const balance = await ps.balanceOf(from.address);
    console.log("balance", balance.toFixed())

    console.log("srcAmount", srcAmount)

    if (balance.isLessThan(srcAmount)) {
      return console.log('balance = ', balance.toFixed(), 'isLessThan srcAmount');
    }

    if (from.address.toLowerCase() !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      const allowance = await ps.allowance(from.address);
      console.log('allowance', allowance.toFixed());

      if (allowance.isLessThan(srcAmount)) {
        console.log('Approval needed, allowance = ', allowance.toFixed());

        await ps.approve(from.address, MAX_UINT);//Can also approve  ps.approve(from.address, srcAmount) but it has to be called on each tx
      }
    }

    const priceRoute = await ps.getRate(from, to, srcAmount);

    const minAmount = new BN(priceRoute.destAmount).times(1 - SLIPPAGE / 100).toFixed(0);

    const txObject = await ps.buildSwap(from, to, srcAmount, minAmount, priceRoute);

    console.log("txObject", txObject);

    const result = await ps.submitTx(txObject);
    console.log('result', result)


  } catch (error) {
    console.error("error", error);
  } finally {
    process.exit();
  }
}

/*
swap(
  1,
  t("ETH", networks.MAINNET),
  t("DAI", networks.MAINNET),
  networks.MAINNET
);
*/

/*
swap(
  1,
  t("MATIC", networks.POLYGON),
  t("USDC", networks.POLYGON),
  networks.POLYGON
);
*/

swap(
  0.5,
  t("USDC", networks.POLYGON),
  t("WBTC", networks.POLYGON),
  networks.POLYGON
);
