#!/usr/bin/env python3
"""Generate XMind mind map from test case document structure."""

import zipfile
import os
import uuid
from xml.etree.ElementTree import Element, SubElement, tostring


def uid():
    return str(uuid.uuid4())


NS = 'urn:xmind:xmap:xmlns:content:2.0'


def add_topic(parent, title_text):
    t = SubElement(parent, f'{{{NS}}}topic', {'id': uid()})
    ti = SubElement(t, f'{{{NS}}}title')
    ti.text = title_text
    return t


def add_children(parent):
    children = SubElement(parent, f'{{{NS}}}children')
    topics = SubElement(children, f'{{{NS}}}topics', {'type': 'attached'})
    return topics


def build_xmind(modules, output_path):
    root = Element(f'{{{NS}}}xmap-content', {
        'xmlns:fo': 'http://www.w3.org/1999/XSL/Format',
        'xmlns:svg': 'http://www.w3.org/2000/svg',
        'xmlns:xhtml': 'http://www.w3.org/1999/xhtml',
        'xmlns:xlink': 'http://www.w3.org/1999/xlink',
        'version': '2.0',
    })

    sheet = SubElement(root, f'{{{NS}}}sheet', {
        'id': uid(),
        'title': '图片笔记小程序 测试用例 V1.0.0',
    })

    root_topic = add_topic(sheet, '图片笔记小程序 测试用例 (约180条)')
    root_children = add_children(root_topic)

    for mod_name, sections in modules:
        mod_topic = add_topic(root_children, mod_name)
        mod_children = add_children(mod_topic)
        for sec_name, cases in sections:
            # Count P0 cases in this section
            p0_count = sum(1 for c in cases if '[P0]' in c)
            display_name = f"{sec_name} ({len(cases)}条, P0:{p0_count}条)"
            sec_topic = add_topic(mod_children, display_name)
            sec_children = add_children(sec_topic)
            for case_name in cases:
                add_topic(sec_children, case_name)

    xml_body = tostring(root, encoding='unicode')
    xml_str = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
               + xml_body)

    manifest = '''<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">
  <file-entry full-path="content.xml" media-type="text/xml"/>
</manifest>'''

    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('content.xml', xml_str.encode('utf-8'))
        zf.writestr('META-INF/manifest.xml', manifest.encode('utf-8'))

    return output_path


# ============================================================
# Build mind map structure from the test case document
# ============================================================

MODULES = [
    ('一、身份建立与数据隔离 F-001', [
        ('正向用例', [
            'TC-AUTH-001 [P0] 新用户首次进入-身份建立成功',
            'TC-AUTH-002 [P0] 老用户再次进入-直接加载数据',
            'TC-AUTH-003 [P1] 会话过期-自动重建身份',
        ]),
        ('异常用例', [
            'TC-AUTH-004 [P0] 登录凭证获取失败',
            'TC-AUTH-005 [P0] 服务端登录服务不可用',
            'TC-AUTH-006 [P1] 列表同步失败',
        ]),
        ('数据隔离', [
            'TC-AUTH-007 [P0] 用户A无法访问用户B的图片',
            'TC-AUTH-008 [P0] 用户A无法访问用户B的备注',
            'TC-AUTH-009 [P0] 跨设备登录-数据一致',
        ]),
    ]),
    ('二、图片选择/压缩/上传 F-002/003/004/013', [
        ('正向用例', [
            'TC-UPLOAD-001 [P0] 从相册选择1张合规图片上传成功',
            'TC-UPLOAD-002 [P0] 拍照上传1张图片成功',
            'TC-UPLOAD-003 [P0] 累计选择20张图片上传',
            'TC-UPLOAD-004 [P0] 含有效EXIF-读取拍摄时间',
            'TC-UPLOAD-005 [P1] 无EXIF-回退上传时间',
            'TC-UPLOAD-006 [P1] 移除上传面板中未成功的任务',
            'TC-UPLOAD-007 [P1] 上传过程中显示实时进度',
        ]),
        ('异常用例', [
            'TC-UPLOAD-008 [P0] 相册权限已拒绝',
            'TC-UPLOAD-009 [P0] 相机权限已拒绝',
            'TC-UPLOAD-010 [P1] 用户取消选择图片',
            'TC-UPLOAD-011 [P1] 用户取消拍照',
            'TC-UPLOAD-012 [P0] 单张图片超过20MB',
            'TC-UPLOAD-013 [P0] 不支持的图片格式(GIF)',
            'TC-UPLOAD-014 [P1] 不支持的图片格式(BMP/WEBP)',
            'TC-UPLOAD-015 [P0] 部分图片上传失败',
            'TC-UPLOAD-016 [P0] 上传过程中网络中断',
            'TC-UPLOAD-017 [P0] 同一任务多次重试不重复创建',
            'TC-UPLOAD-018 [P0] 存储空间不足(已用100%)',
            'TC-UPLOAD-019 [P1] 压缩失败处理',
            'TC-UPLOAD-020 [P1] 压缩后超过目标大小-降质处理',
            'TC-UPLOAD-021 [P1] 网络切换中断上传',
        ]),
        ('上传面板生命周期', [
            'TC-UPLOAD-022 [P0] 关闭面板-提示确认',
            'TC-UPLOAD-023 [P0] 小程序进入后台-任务取消',
            'TC-UPLOAD-024 [P1] 超过20张阻止继续选择',
        ]),
        ('批量标签入口', [
            'TC-UPLOAD-025 [P1] 上传成功后有批量标签入口',
            'TC-UPLOAD-026 [P1] 全部失败不显示批量标签入口',
        ]),
    ]),
    ('三、图片浏览 F-005/006', [
        ('图片列表', [
            'TC-BROWSE-001 [P1] 图片列表空态',
            'TC-BROWSE-002 [P0] 图片列表正常展示',
            'TC-BROWSE-003 [P1] 图片列表-备注标记展示(0/1/2/99+)',
            'TC-BROWSE-004 [P1] 下拉刷新-保留布局差量更新',
            'TC-BROWSE-005 [P0] 点击图片进入预览',
            'TC-BROWSE-006 [P1] 列表加载失败',
        ]),
        ('图片预览与详情', [
            'TC-BROWSE-007 [P0] 大图预览-正常展示',
            'TC-BROWSE-008 [P1] 图片加载失败-备注仍展示',
            'TC-BROWSE-009 [P1] 图片已被删除-提示并返回',
            'TC-BROWSE-010 [P1] 无备注状态',
            'TC-BROWSE-011 [P1] 备注区展示创建时间和编辑状态',
        ]),
    ]),
    ('四、备注管理 F-007/008/009', [
        ('新增备注', [
            'TC-NOTE-001 [P0] 新增备注-正常保存',
            'TC-NOTE-002 [P1] 备注支持Emoji和特殊Unicode',
            'TC-NOTE-003 [P1] 备注支持内部换行',
            'TC-NOTE-004 [P1] 保存期间按钮禁用',
        ]),
        ('备注校验', [
            'TC-NOTE-005 [P0] 内容为空-禁止保存',
            'TC-NOTE-006 [P0] 内容仅为空白字符-禁止保存',
            'TC-NOTE-007 [P0] 超过1000个Unicode code point-禁止',
            'TC-NOTE-008 [P1] 恰好1000个code point-成功',
            'TC-NOTE-009 [P1] 恰好1个code point-成功',
            'TC-NOTE-010 [P1] 字数实时显示 N/1000',
            'TC-NOTE-011 [P0] 图片已被删除时添加备注',
        ]),
        ('修改备注', [
            'TC-NOTE-012 [P0] 修改备注-正常保存',
            'TC-NOTE-013 [P1] 取消无改动-直接关闭',
            'TC-NOTE-014 [P1] 取消有改动-二次确认',
            'TC-NOTE-015 [P0] 版本冲突处理',
            'TC-NOTE-016 [P0] 冲突-加载最新内容',
            'TC-NOTE-017 [P0] 冲突-继续提交覆盖',
            'TC-NOTE-018 [P1] 继续提交时再次冲突',
            'TC-NOTE-019 [P1] 冲突后关闭编辑层-内容不保留',
        ]),
        ('删除备注', [
            'TC-NOTE-020 [P0] 删除备注-正常流程',
            'TC-NOTE-021 [P1] 删除备注-用户取消',
            'TC-NOTE-022 [P1] 删除最后一条-标记移除',
            'TC-NOTE-023 [P1] 删除多备注中的一条',
        ]),
        ('保存异常恢复', [
            'TC-NOTE-024 [P0] 保存时网络异常-保留输入可重试',
        ]),
    ]),
    ('五、备注浏览与反向定位 F-010/011', [
        ('备注列表', [
            'TC-NOTEVIEW-001 [P1] 默认排序-创建时间从新到旧',
            'TC-NOTEVIEW-002 [P1] 四种排序方式切换',
            'TC-NOTEVIEW-003 [P1] 备注列表空态',
            'TC-NOTEVIEW-004 [P1] 加载失败',
            'TC-NOTEVIEW-005 [P1] 下拉刷新',
            'TC-NOTEVIEW-006 [P1] 触底分页',
            'TC-NOTEVIEW-007 [P2] 内容超出3行省略',
        ]),
        ('反向定位', [
            'TC-NOTEVIEW-008 [P0] 点击备注-定位到对应图片+高亮',
            'TC-NOTEVIEW-009 [P0] 关联内容已删除-提示刷新',
            'TC-NOTEVIEW-010 [P1] 图片加载失败时备注仍可见',
        ]),
    ]),
    ('六、永久删除 F-012', [
        ('删除图片', [
            'TC-DELETE-001 [P0] 删除图片-正常流程(级联:图片+备注+标签关联)',
            'TC-DELETE-002 [P1] 用户取消-数据不变',
            'TC-DELETE-003 [P0] 服务端失败-提示重试',
            'TC-DELETE-004 [P1] 已被其他设备删除-按成功处理',
            'TC-DELETE-005 [P1] 重复删除幂等',
            'TC-DELETE-006 [P1] 列表页不提供批量删除',
        ]),
    ]),
    ('七、隐私说明与能力授权 F-014', [
        ('权限控制', [
            'TC-PRIVACY-001 [P0] 不提前申请相册/相机权限',
            'TC-PRIVACY-002 [P0] 仅在使用时申请对应能力',
            'TC-PRIVACY-003 [P1] 隐私说明覆盖收集目的',
            'TC-PRIVACY-004 [P1] 拒绝相机不影响相册',
            'TC-PRIVACY-005 [P1] 拒绝相册不影响相机',
        ]),
    ]),
    ('八、用户注销 F-015', [
        ('注销主流程', [
            'TC-LOGOUT-001 [P0] 注销成功完整流程(冻结+异步清理+解绑)',
            'TC-LOGOUT-002 [P0] 首次确认文案完整性',
            'TC-LOGOUT-003 [P1] 提交期间按钮禁用防重复',
        ]),
        ('注销文字校验', [
            'TC-LOGOUT-004 [P0] 确认文字不一致-禁止提交',
            'TC-LOGOUT-005 [P0] 确认文字为空-禁止提交',
            'TC-LOGOUT-006 [P1] 确认文字前后有空格-不匹配',
            'TC-LOGOUT-007 [P1] 确认文字大小写不同-不匹配',
        ]),
        ('注销异常流程', [
            'TC-LOGOUT-008 [P1] 重复提交注销-返回已有任务',
            'TC-LOGOUT-009 [P0] DELETING状态再次进入-仅PG-008',
            'TC-LOGOUT-010 [P0] 清理部分失败-自动重试',
            'TC-LOGOUT-011 [P0] 注销完成后再次进入-全新空账号',
            'TC-LOGOUT-012 [P1] 注销申请失败-停留当前页可重试',
        ]),
    ]),
    ('九、标签浏览与图片筛选 F-016', [
        ('标签筛选区展示', [
            'TC-TAGFILTER-001 [P1] 新会话默认选中全部',
            'TC-TAGFILTER-002 [P1] 0个标签-显示新建入口',
            'TC-TAGFILTER-003 [P1] 1~5个标签-全部展示+管理',
            'TC-TAGFILTER-004 [P1] 6~100个标签-最近5个+更多',
            'TC-TAGFILTER-005 [P1] 标签数量跨越边界时自适应切换',
            'TC-TAGFILTER-006 [P1] 标签区加载失败不影响图片浏览',
        ]),
        ('标签筛选功能', [
            'TC-TAGFILTER-007 [P1] 全部-展示所有图片',
            'TC-TAGFILTER-008 [P1] 未分类-仅展示无标签图片',
            'TC-TAGFILTER-009 [P1] 用户标签筛选-关联图片分页',
            'TC-TAGFILTER-010 [P1] 标签筛选-空结果',
            'TC-TAGFILTER-011 [P1] 未分类为空',
            'TC-TAGFILTER-012 [P1] 筛选后返回保留状态(筛选+列表+滚动)',
            'TC-TAGFILTER-013 [P1] 新会话/冷启动恢复全部',
            'TC-TAGFILTER-014 [P1] 标签已在其他设备删除-提示切换全部',
            'TC-TAGFILTER-015 [P0] 点击他人标签ID-拒绝访问',
            'TC-TAGFILTER-016 [P1] 标签筛选失败-保留状态可重试',
            'TC-TAGFILTER-017 [P1] 从PG-009点击标签返回并筛选',
        ]),
    ]),
    ('十、标签创建/重命名/删除 F-017', [
        ('创建标签-正常', [
            'TC-TAG-001 [P1] 创建标签-正常',
            'TC-TAG-002 [P1] 标签名称1个code point',
            'TC-TAG-003 [P1] 标签名称12个code point',
            'TC-TAG-004 [P1] 标签名称含内部空格',
            'TC-TAG-005 [P1] 标签名称含Emoji',
            'TC-TAG-006 [P1] 标签名称首尾含空白-自动去除',
        ]),
        ('创建标签-校验', [
            'TC-TAG-007 [P1] 标签名称为空',
            'TC-TAG-008 [P1] 标签名称为纯空白字符',
            'TC-TAG-009 [P1] 标签名称超过12个code point',
            'TC-TAG-010 [P1] 标签名称含换行符',
            'TC-TAG-011 [P1] 标签名称含控制字符',
            'TC-TAG-012 [P1] 标签名称重复(完全相同)',
            'TC-TAG-013 [P1] 标签名称重复(仅大小写不同)',
            'TC-TAG-014 [P1] 命中保留名称"全部"',
            'TC-TAG-015 [P1] 命中保留名称"未分类"',
            'TC-TAG-016 [P1] 标签达到100个上限',
        ]),
        ('重命名标签', [
            'TC-TAG-017 [P1] 重命名标签-正常(全局更新)',
            'TC-TAG-018 [P2] 重命名-预填原名称',
            'TC-TAG-019 [P1] 新名称与已有标签重复',
            'TC-TAG-020 [P1] 标签已被其他设备删除',
            'TC-TAG-021 [P1] 重命名-网络异常',
        ]),
        ('删除标签', [
            'TC-TAG-022 [P1] 删除标签-正常(级联:标签+关联,保留图片)',
            'TC-TAG-023 [P1] 删除标签-用户取消',
            'TC-TAG-024 [P1] 已被其他设备删除-按成功处理',
            'TC-TAG-025 [P1] 删除标签-网络异常',
            'TC-TAG-026 [P1] 删除关联0张图片的标签',
        ]),
    ]),
    ('十一、单张图片标签维护 F-018', [
        ('正常流程', [
            'TC-PHOTOTAG-001 [P1] 为无标签图片添加标签',
            'TC-PHOTOTAG-002 [P1] 添加第5个标签',
            'TC-PHOTOTAG-003 [P1] 移除图片全部标签-进入未分类',
            'TC-PHOTOTAG-004 [P1] PG-010内创建标签并自动选中',
            'TC-PHOTOTAG-005 [P1] 已选5个时创建新标签不自动选中',
            'TC-PHOTOTAG-006 [P1] 按增量方式提交(差集)',
        ]),
        ('限制与校验', [
            'TC-PHOTOTAG-007 [P1] 选择第6个标签被阻止+禁用',
            'TC-PHOTOTAG-008 [P1] 取消一个后恢复选择',
            'TC-PHOTOTAG-009 [P1] 重复添加同一标签-幂等',
        ]),
        ('异常流程', [
            'TC-PHOTOTAG-010 [P0] 保存时图片已被删除',
            'TC-PHOTOTAG-011 [P1] 部分已选标签在其他设备被删除',
            'TC-PHOTOTAG-012 [P1] 保存时网络异常-保留选择',
            'TC-PHOTOTAG-013 [P1] 重复点击保存-按钮禁用',
            'TC-PHOTOTAG-014 [P1] 未保存关闭-确认提示',
            'TC-PHOTOTAG-015 [P0] 点击他人标签-拒绝访问',
            'TC-PHOTOTAG-016 [P1] 标签列表加载失败',
        ]),
    ]),
    ('十二、批量添加标签 F-019', [
        ('正常流程', [
            'TC-BATCHTAG-001 [P1] 为8张成功图片批量添加标签',
            'TC-BATCHTAG-002 [P1] 跳过批量标签-成功图片保持无标签',
            'TC-BATCHTAG-003 [P2] 默认不选标签-保存按钮禁用',
            'TC-BATCHTAG-004 [P1] 未选标签时保存按钮禁用',
            'TC-BATCHTAG-005 [P1] 集合合并语义-重复不增加',
        ]),
        ('异常流程', [
            'TC-BATCHTAG-006 [P1] 部分图片已被删除-返回成功/失效数',
            'TC-BATCHTAG-007 [P1] 批量保存失败-网络异常-保留选择',
            'TC-BATCHTAG-008 [P1] 重复请求幂等',
            'TC-BATCHTAG-009 [P1] 全部失败不显示入口',
            'TC-BATCHTAG-010 [P1] 失败重试成功不自动继承批量标签',
        ]),
    ]),
    ('状态机测试', [
        ('上传任务状态机 (7状态)', [
            'TC-STATE-001 [P0] 待处理→压缩中',
            'TC-STATE-002 [P0] 压缩中→待上传',
            'TC-STATE-003 [P0] 待上传→上传中',
            'TC-STATE-004 [P0] 上传中→成功(终态)',
            'TC-STATE-005 [P0] 非终态→失败',
            'TC-STATE-006 [P0] 失败→待处理(重试)',
            'TC-STATE-007 [P0] 非终态→已取消(终态)',
            'TC-STATE-008 [P0] 成功状态不可变',
            'TC-STATE-009 [P0] 已取消状态不可变',
            'TC-STATE-010 [P0] 重试不重复创建图片(幂等)',
        ]),
        ('用户账号状态机 ACTIVE→DELETING→DELETED', [
            'TC-STATE-011 [P0] ACTIVE→DELETING',
            'TC-STATE-012 [P0] DELETING拒绝业务访问',
            'TC-STATE-013 [P0] DELETING→DELETED',
            'TC-STATE-014 [P0] DELETED按新用户创建空账号',
            'TC-STATE-015 [P1] DELETING重复提交返回已有任务',
        ]),
        ('注销任务状态机 待处理→处理中→重试中→已完成', [
            'TC-STATE-016 [P0] 待处理→处理中',
            'TC-STATE-017 [P0] 处理中→重试中(阶段失败)',
            'TC-STATE-018 [P0] 重试中→处理中(自动重试)',
            'TC-STATE-019 [P0] 处理中→已完成(终态)',
        ]),
    ]),
    ('集成测试', [
        ('主流程集成', [
            'TC-INT-001 [P0] 完整主流程:登录→上传→备注→标签→回看→删除',
            'TC-INT-002 [P0] 备注冲突→继续提交→再次冲突',
            'TC-INT-003 [P1] 上传→批量标签→删除标签→验证未分类',
            'TC-INT-004 [P0] 跨设备数据同步',
        ]),
        ('页面跳转集成', [
            'TC-INT-005 [P1] Tab切换保留滚动位置',
            'TC-INT-006 [P1] 上传→关闭面板→刷新列表',
            'TC-INT-007 [P1] 备注列表→详情→返回保留位置',
            'TC-INT-008 [P1] 标签管理→点击标签→返回筛选',
        ]),
        ('数据一致性集成', [
            'TC-INT-009 [P0] 删除图片-全链路一致性',
            'TC-INT-010 [P1] 备注数量一致性(不为负)',
            'TC-INT-011 [P1] 标签关联图片数量一致性(不为负)',
            'TC-INT-012 [P0] 注销-全链路一致性',
        ]),
    ]),
    ('非功能测试', [
        ('性能测试 (11条 P95指标)', [
            'TC-PERF-001 [P0] 图片列表首屏 P95≤3s',
            'TC-PERF-002 [P0] 备注列表首屏 P95≤2s',
            'TC-PERF-003 [P0] 备注保存 P95≤1s',
            'TC-PERF-004 [P1] 元数据接口 P95≤800ms',
            'TC-PERF-005 [P0] 上传并发≤3张',
            'TC-PERF-006 [P1] 快捷标签首屏 P95≤800ms',
            'TC-PERF-007 [P1] 全部标签列表 P95≤1s',
            'TC-PERF-008 [P1] 标签筛选图片首屏 P95≤2s',
            'TC-PERF-009 [P1] 单图标签保存 P95≤1s',
            'TC-PERF-010 [P1] 批量标签保存 P95≤2s',
            'TC-PERF-011 [P0] 缩略图不加载2560px原图',
        ]),
        ('安全测试 (9条)', [
            'TC-SEC-001 [P0] HTTPS传输',
            'TC-SEC-002 [P0] 越权访问-图片',
            'TC-SEC-003 [P0] 越权访问-备注',
            'TC-SEC-004 [P0] 越权访问-标签',
            'TC-SEC-005 [P0] 服务端鉴权绕过(不信任客户端userID)',
            'TC-SEC-006 [P1] 图片URL不可猜测',
            'TC-SEC-007 [P0] 前端无密钥泄露',
            'TC-SEC-008 [P1] 日志不记录敏感内容',
            'TC-SEC-009 [P1] 错误信息不泄露他人数据',
        ]),
        ('兼容性测试 (5条)', [
            'TC-COMPAT-001 [P0] iOS微信主流版本',
            'TC-COMPAT-002 [P0] Android微信主流版本',
            'TC-COMPAT-003 [P1] 低版本基础库升级提示',
            'TC-COMPAT-004 [P1] 不同屏幕尺寸/安全区/字体缩放',
            'TC-COMPAT-005 [P2] 平板/PC基本可用',
        ]),
        ('并发与一致性测试 (7条)', [
            'TC-CONSIST-001 [P0] 备注并发修改-乐观锁',
            'TC-CONSIST-002 [P1] 标签并发创建同名-只成功一个',
            'TC-CONSIST-003 [P1] 图片标签关联并发操作',
            'TC-CONSIST-004 [P1] 关联计数一致性',
            'TC-CONSIST-005 [P0] 删除一致性-图片(记录+对象+备注+关联)',
            'TC-CONSIST-006 [P1] 删除一致性-标签(记录+关联)',
            'TC-CONSIST-007 [P0] 注销一致性(全部清除后解绑)',
        ]),
        ('降级与容错测试 (3条)', [
            'TC-FAULT-001 [P1] 标签接口故障不阻断图片浏览',
            'TC-FAULT-002 [P1] 图片列表接口故障-错误恢复',
            'TC-FAULT-003 [P1] 上传时对象存储异常',
        ]),
    ]),
    ('【冒烟测试清单 12条 - 每轮必执行】', [
        ('身份&上传', [
            '1. TC-AUTH-001 新用户首次进入-身份建立成功',
            '2. TC-UPLOAD-001 从相册选择1张合规图片上传成功',
            '3. TC-UPLOAD-015 部分图片上传失败',
        ]),
        ('浏览&备注', [
            '4. TC-BROWSE-002 图片列表正常展示',
            '5. TC-BROWSE-007 大图预览-正常展示',
            '6. TC-NOTE-001 新增备注-正常保存',
        ]),
        ('回看&删除', [
            '7. TC-NOTEVIEW-008 点击备注-定位到对应图片和备注',
            '8. TC-DELETE-001 删除图片-正常流程',
        ]),
        ('标签&注销', [
            '9. TC-TAGFILTER-001 新会话默认选中全部',
            '10. TC-TAG-001 创建标签-正常',
            '11. TC-PHOTOTAG-001 为无标签图片添加标签',
            '12. TC-LOGOUT-001 注销成功完整流程',
        ]),
    ]),
]


if __name__ == '__main__':
    output_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'docs',
        '测试用例-图片笔记小程序-V1.0.0.xmind'
    )
    build_xmind(MODULES, output_path)
    size_kb = os.path.getsize(output_path) / 1024
    print(f'XMind file created: {output_path}')
    print(f'File size: {size_kb:.1f} KB')
