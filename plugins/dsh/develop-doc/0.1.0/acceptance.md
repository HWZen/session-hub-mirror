# DSH 0.1.0 验收摘要

首次宿主验收暴露了连接配置可用性问题：当时的 Host-only 插件没有可填写第三方 Config 的设置界面。0.1.1 增加共享配置读取，使通用安装可以通过用户目录 `config.json` 完成。采集依赖持久服务 flush/read 与官方 subprocess seam。

后续验收与可复用安装步骤见 `../0.1.1/acceptance.md` 和 `../../../README.md`。原始会话、设备路径和运行记录私有保管。
