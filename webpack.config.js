const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const pkg = require('./package.json');

// 仓库地址只在 package.json 维护：去掉 git+ 前缀和 .git 后缀，得到可直接打开的 https 地址
const repositoryUrl = String(pkg.repository?.url || pkg.repository || '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');

// 端口与 src-tauri/tauri.conf.json 的 devUrl 保持一致，改一处要改另一处
const DEV_SERVER_PORT = 1420;

module.exports = (_env, argv) => {
  const isDev = argv.mode !== 'production';

  return {
    entry: './src/index.tsx',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isDev ? 'assets/[name].js' : 'assets/[name].[contenthash:8].js',
      publicPath: '/',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.css'],
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    module: {
      rules: [
        {
          test: /\.(ts|tsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'swc-loader',
            options: {
              jsc: {
                parser: { syntax: 'typescript', tsx: true },
                transform: {
                  react: { runtime: 'automatic', development: isDev },
                },
              },
            },
          },
        },
        {
          test: /\.module\.css$/,
          use: [
            isDev ? 'style-loader' : MiniCssExtractPlugin.loader,
            {
              loader: 'css-loader',
              options: {
                modules: {
                  // css-loader v7 默认把类名当具名导出，`import s from` 会拿到 undefined 导致白屏
                  namedExport: false,
                  exportLocalsConvention: 'camelCaseOnly',
                  localIdentName: isDev ? '[name]__[local]' : '[hash:base64:6]',
                },
              },
            },
          ],
        },
        {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          use: [isDev ? 'style-loader' : MiniCssExtractPlugin.loader, 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({ template: './index.html' }),
      // 版本号只在 package.json 里维护，构建时注入成 __APP_VERSION__
      new webpack.DefinePlugin({
        __APP_VERSION__: JSON.stringify(pkg.version),
        __APP_REPOSITORY__: JSON.stringify(repositoryUrl),
      }),
      ...(isDev
        ? []
        : [new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash:8].css' })]),
    ],
    devServer: {
      port: DEV_SERVER_PORT,
      hot: true,
      historyApiFallback: true,
      allowedHosts: 'all',
      client: { overlay: false },
    },
    devtool: isDev ? 'eval-cheap-module-source-map' : 'source-map',
  };
};
