# SPDX-License-Identifier: GPL-2.0-or-later

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOMOC_PATH_PREFIX ON)
find_package(Qt6 REQUIRED COMPONENTS CorePrivate GuiPrivate TestPrivate ShaderToolsPrivate)
set(QT_NATIVE_TESTS "${PROJECT_SOURCE_DIR}/externals/qtbase/tests/manual/wasm")
set(QT_NATIVE_TESTLIB "${QT_NATIVE_TESTS}/qtwasmtestlib")
set(QT_NATIVE_TIMERS "${QT_NATIVE_TESTS}/eventloop/suspendresumecontrol_auto")

qt_add_executable(suspendresumecontrol_auto MANUAL_FINALIZATION
    "${QT_NATIVE_TIMERS}/main.cpp"
    "${QT_NATIVE_TESTLIB}/qtwasmtestlib.cpp")
target_include_directories(suspendresumecontrol_auto PRIVATE "${QT_NATIVE_TESTLIB}")
target_link_libraries(suspendresumecontrol_auto PRIVATE Qt6::Core Qt6::CorePrivate)
set_target_properties(suspendresumecontrol_auto PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
qt_finalize_executable(suspendresumecontrol_auto)
add_custom_command(TARGET suspendresumecontrol_auto POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy
        "${QT_NATIVE_TIMERS}/suspendresumecontrol_auto.html"
        "$<TARGET_FILE_DIR:suspendresumecontrol_auto>/suspendresumecontrol_auto.html"
    COMMAND "${CMAKE_COMMAND}" -E copy "${QT_NATIVE_TESTLIB}/qtwasmtestlib.js"
        "$<TARGET_FILE_DIR:suspendresumecontrol_auto>/qtwasmtestlib.js"
    VERBATIM)

qt_add_executable(dialog_exec "${QT_NATIVE_TESTS}/eventloop/dialog_exec/main.cpp")
target_link_libraries(dialog_exec PRIVATE Qt6::Widgets)
set_target_properties(dialog_exec PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

qt_add_executable(foreignwindows "${QT_NATIVE_TESTS}/foreignwindows/main.cpp")
target_link_libraries(foreignwindows PRIVATE Qt6::Widgets)
set_target_properties(foreignwindows PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

qt_add_executable(localfiles "${QT_NATIVE_TESTS}/localfiles/main.cpp")
target_link_libraries(localfiles PRIVATE Qt6::Widgets)
set_target_properties(localfiles PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

set(QT_MODEL_TESTS "${PROJECT_SOURCE_DIR}/externals/qtbase/tests/auto/corelib/itemmodels")
set(QT_MODEL_UTILS "${QT_MODEL_TESTS}/../../other/qabstractitemmodelutils")
qt_add_executable(tst_qabstractitemmodel
    "${QT_MODEL_TESTS}/qabstractitemmodel/tst_qabstractitemmodel.cpp"
    "${QT_MODEL_UTILS}/dynamictreemodel.cpp"
    "${QT_MODEL_UTILS}/dynamictreemodel.h")
target_include_directories(tst_qabstractitemmodel PRIVATE "${QT_MODEL_UTILS}")
target_link_libraries(tst_qabstractitemmodel PRIVATE Qt6::Gui Qt6::TestPrivate)

qt_add_executable(tst_qabstractproxymodel
    "${QT_MODEL_TESTS}/qabstractproxymodel/tst_qabstractproxymodel.cpp")
target_compile_definitions(tst_qabstractproxymodel PRIVATE QTEST_THROW_ON_FAIL QTEST_THROW_ON_SKIP)
target_link_libraries(tst_qabstractproxymodel PRIVATE Qt6::Gui Qt6::TestPrivate)
set_target_properties(tst_qabstractitemmodel tst_qabstractproxymodel PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

set(QT_SHADER_TESTS "${PROJECT_SOURCE_DIR}/externals/qtshadertools/tests/auto/qshaderbaker")
qt_add_executable(tst_qshaderbaker "${QT_SHADER_TESTS}/tst_qshaderbaker.cpp")
target_link_libraries(tst_qshaderbaker PRIVATE Qt6::GuiPrivate Qt6::Test Qt6::ShaderToolsPrivate)
file(GLOB_RECURSE QT_SHADER_TEST_DATA CONFIGURE_DEPENDS "${QT_SHADER_TESTS}/data/*")
qt_add_resources(tst_qshaderbaker qshaderbaker
    PREFIX "/" BASE "${QT_SHADER_TESTS}" FILES ${QT_SHADER_TEST_DATA})
set_target_properties(tst_qshaderbaker PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

add_custom_target(azahar_qt_model_fixtures
    DEPENDS tst_qabstractitemmodel tst_qabstractproxymodel)
add_custom_target(azahar_qt_native_fixtures
    DEPENDS suspendresumecontrol_auto dialog_exec foreignwindows localfiles
        azahar_qt_model_fixtures tst_qshaderbaker)
