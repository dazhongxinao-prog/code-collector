# 代码回收系统 · Code Collector

**作者：dazhong（大中信奥）** · ISC License · 早期公开版本

为编程课堂、训练营和模拟考试提供代码提交、交卷锁定、统一归档和批量导出。
希望让老师少花时间收文件、改文件名和整理目录，把时间留给教学。

> 当前版本是收卷工具，不编译代码、不执行测试点、不自动判分。
> 尚未完成正式考试级可靠性验证。请先阅读 [已知限制](KNOWN_ISSUES.md)，在隔离环境试用。

## 在线预览

[打开代码回收系统](https://open.moblm.com/csp-collector/)

提交代码及教师管理功能需要相应账号权限。

## 功能

- 多比赛管理；草稿、发布、激活、归档与配置历史。
- 教师题库选题，PDF / ZIP 资料分发。
- 学生上传代码或粘贴文本；自动规范文件名和归档目录。
- 显示文件大小、MD5、提交时间，支持最终交卷锁定。
- 教师查看已有提交记录，导出单人或全场代码包。
- 打印提交确认单。
- 支持 LearnHouse 登录会话与教师角色授权。

## 项目结构

- server.js：Express 后端与文件存储。
- adminAccess.js：教师 / 管理员角色判断。
- public/index.html、public/js/app.js：学生端。
- public/admin.html、public/js/admin.js：教师端。
- data/contests.json、data/question-bank.json：通用示例数据。
- test/：权限、题库、资料发布下载相关测试。
- standalone.html：保留的旧版页面，不建议作为新部署入口。

## 本地试用

需要支持内置 fetch 的 Node.js；建议使用 Node.js 22 或更新兼容版本。
先安装依赖，再启动：

~~~sh
npm install
npm start
~~~

- 学生端：http://localhost:3456/
- 教师端：http://localhost:3456/admin

直接启动可以浏览公开示例，但不会自动获得学生或教师身份。

### 不接入 LearnHouse 的本地演示（PowerShell）

~~~powershell
$env:CODE_COLLECTOR_DEV_AUTH = 'true'
$env:NODE_ENV = 'development'
$env:ADMIN_SECRET = [guid]::NewGuid().ToString('N')
Write-Host "本次本地教师演示密钥：" $env:ADMIN_SECRET
npm start
~~~

在本机访问 localhost，学生端使用演示账号；教师端输入本次生成的密钥。
这只是本机演示入口，不是独立的用户注册登录系统。不要将此模式暴露到公网。
关闭 PowerShell 会话可清除本次设置的进程环境变量。

### LearnHouse 集成

当前代码使用 LH_access Cookie，并向
http://127.0.0.1:9000/api/v1/users/session 校验身份。
部署者需要自己配置 LearnHouse、同站 Cookie 和反向代理；源码包不包含这些服务。

生产环境必须关闭 CODE_COLLECTOR_DEV_AUTH 并设置 NODE_ENV=production。
设置 CODE_COLLECTOR_DATA_DIR 将运行数据存到仓库外，并建立独立备份。
原有部署采用 /csp-collector/ 子路径；根路径部署仍有已知的资料接口路径问题，见已知限制。

## 数据和公开版本

- 本公开版以通用示例替换原比赛配置和原题库。
- 不包含原包内的姓名、考号、座位及旧提交记录。
- 学生提交、上传资料、运行锁定记录与凭据不应进入 Git。
- 发布后的比赛资料可供学生下载，上传前应自行确认其内容适合公开。
- 第三方题目、资料和用户提交内容的权利由其权利人保留。

## 测试

~~~sh
npm test
~~~

已有测试主要覆盖管理员角色、题库与资料发布下载。
通过这些测试不等同于通过上传并发、断电恢复、考场验收或安全审计。

## 参与改进

欢迎通过 Issues 反馈问题，通过 Pull Request 提交改进。
当前优先事项：严格比赛定位与时间校验、统一提交校验、原子保存与提交历史、
真实考生名单、导出完整性验证，以及独立部署体验。

请勿在公开 Issue 中上传学生隐私、真实代码提交、密码或令牌。

## License

源码沿用原项目声明的 ISC 许可证，完整文本见 [LICENSE](LICENSE)。
作者署名：**dazhong**。